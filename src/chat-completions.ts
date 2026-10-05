// chat-completions.ts — POST /v1/chat/completions para TUIs tipo opencode.
//
// OpenISy/opencode consume providers OpenAI-compatibles via
// `@ai-sdk/openai-compatible`, que habla `/chat/completions` (no Responses).
// Este bridge solo tenia Responses, asi que opencode no lo podia usar como
// provider. Esta ruta mapea chat -> turno web y responde el objeto chat.
//
// Honestidad copiada de web-responses.ts: en stream=true el texto sale como UN
// delta y luego [DONE]; los usage son ESTIMADOS (chars/4), no tokens reales.
// Solo modelos chatgpt-web/*; otro modelo falla cerrado (no se reenvia al
// upstream Codex porque la forma chat no es la suya).
//
// v1 contexto-por-archivo (CODEX_WEB_HTTP_CONTEXT_FILE=1): el contexto del chat
// vive en un .txt local (~/.codex-web-http/context/); el bridge lo empuja por
// partes chicas (la caja nunca lleva el texto completo) y recien despues pide
// la respuesta final. El .txt crece en disco; lo nuevo se empuja en el proximo
// request. La tool read queda disponible para pedidos de mas contexto.
import { sendWebTurn } from "./web-turn";
import { isWebModel } from "./web-responses";
import type { AppConfig } from "./config";
import {
  makeContextKey, parseReadCall, readContextSlice, renderReadResult,
  writeContextFile,
} from "./context-file";

const encoder = new TextEncoder();
const SSE_DONE = "data: [DONE]";

export interface ChatWebRequest {
  model: string;
  prompt: string;
  stream: boolean;
  /** Clave estable por conversacion para el archivo de contexto local. */
  key: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Mapea un body chat.completions a {model, prompt, stream, key}.
 * system -> instrucciones al frente; el resto como transcript "role: texto".
 * Devuelve null si no es un turno web valido (modelo ajeno o sin texto).
 */
export function chatBodyToWebRequest(body: unknown): ChatWebRequest | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (!isWebModel(record.model)) return null;
  const messages = record.messages;
  if (!Array.isArray(messages)) return null;
  const system: string[] = [];
  const turns: string[] = [];
  let firstUser = "";
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "";
    const text = textOf(message.content).trim();
    if (!text) continue;
    if (role === "system") system.push(text);
    else if (role === "user" || role === "assistant") {
      if (role === "user" && !firstUser) firstUser = text;
      turns.push(`${role}: ${text}`);
    } else turns.push(text);
  }
  const prompt = [...system, ...turns].join("\n\n").trim();
  if (!prompt) return null;
  const model = record.model as string;
  return {
    model, prompt, stream: record.stream === true,
    key: makeContextKey(model, system.join("\n"), firstUser),
  };
}

/** chars/4, estimado: el bridge no tiene el tokenizer de Codex. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Objeto `chat.completion` (contrato OpenAI). */
export function buildChatCompletion(model: string, text: string, prompt: string): Record<string, unknown> {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(text);
  return {
    id: `chatcmpl-cwh_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/** SSE con UN delta de texto + done. Misma honestidad que web-responses. */
export function buildChatStream(model: string, text: string): ReadableStream<Uint8Array> {
  const id = `chatcmpl-cwh_${crypto.randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: unknown, finish: string | null): Uint8Array =>
    encoder.encode(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk({ role: "assistant", content: text }, null));
      controller.enqueue(chunk({}, "stop"));
      controller.enqueue(encoder.encode(`${SSE_DONE}\n\n`));
      controller.close();
    },
  });
}

function errorJson(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

/** Un turno web simple (transporte clasico: todo el texto en la caja). */
async function sendSingleTurn(web: ChatWebRequest, config: AppConfig): Promise<string> {
  const result = await sendWebTurn(web.prompt, {
    statePath: config.browserStatePath,
    browser: config.browser,
    headed: config.browserHeaded,
    deadlineMs: config.webTurnDeadlineMs,
  });
  if (!result.submitted || !result.text) {
    throw new Error(`web_no_response: submitted=${result.submitted} ms=${result.ms} url=${result.url}`);
  }
  return result.text;
}

/** Lineas ya ingestadas por chat (en memoria; al reiniciar se relee todo). */
const contextReadState = new Map<string, number>();
const CONTEXT_MAX_ROUNDS = 60;

/**
 * Flujo v1: el contexto vive en un .txt local. ChatGPT web no emite un sobre
 * de tool sin una tool real delante, asi que el bridge lo empuja por partes
 * (<= 200 lineas / 10 KB cada una): la caja nunca lleva el texto completo y el
 * archivo sigue creciendo en disco. Lo nuevo se empuja en el proximo request.
 */
async function runContextFileFlow(web: ChatWebRequest, config: AppConfig): Promise<string> {
  const written = writeContextFile(web.key, web.prompt);
  let readFrom = contextReadState.get(web.key) ?? 0;
  if (readFrom > written.total) readFrom = 0;

  let offset = readFrom;
  let part = 0;
  const totalParts = Math.max(1, Math.ceil((written.total - readFrom) / 200));
  while (offset < written.total) {
    part++;
    const slice = readContextSlice(written.path, offset, 200);
    offset = slice.next;
    const prompt = [
      `[context-file parte ${part}/${totalParts}] archivo: ${written.path}`,
      slice.content,
      "",
      "(Solo confirma con ACK. Todavia no respondas la tarea.)",
    ].join("\n");
    await sendSingleTurn({ ...web, prompt }, config);
  }
  contextReadState.set(web.key, written.total);
  console.error(`[codex-web-http] context pushed parts=${part} lines=${written.total} from=${readFrom}`);

  let prompt =
    "ACK. El contexto esta ingestado. Ahora produce la respuesta final al ultimo pedido del contexto. " +
    "Si aun te falta leer algo, usa read otra vez con el mismo sobre JSON; si no, responde solo la respuesta final en texto plano (sin sobre JSON).";
  for (let round = 0; round < CONTEXT_MAX_ROUNDS; round++) {
    const reply = await sendSingleTurn({ ...web, prompt }, config);
    const call = parseReadCall(reply);
    if (!call) return reply;
    const slice = readContextSlice(call.path, call.offset, call.limit);
    contextReadState.set(web.key, Math.max(contextReadState.get(web.key) ?? 0, slice.next));
    prompt = renderReadResult(slice);
  }
  throw new Error("web_context_answer_loop: demasiadas rondas de read");
}

/** Atiende POST /v1/chat/completions con modelo Web. */
export async function handleChatCompletions(req: Request, config: AppConfig): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "chat_invalid_json", "el body no es JSON");
  }
  const web = chatBodyToWebRequest(body);
  if (!web) {
    return errorJson(400, "not_web_model", "solo modelos chatgpt-web/* con messages no vacios");
  }
  let text: string;
  try {
    text = config.contextFile ? await runContextFileFlow(web, config) : await sendSingleTurn(web, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const named = /^(web_[a-z_]+)/.exec(message)?.[1];
    const status = named === "web_session_missing" || named === "web_session_expired" ? 503 : 502;
    return errorJson(status, named ?? "web_turn_failed", message);
  }
  console.error(
    `[codex-web-http] web chat turn ok: model=${web.model} context_file=${config.contextFile} chars=${text.length}`,
  );
  return web.stream
    ? new Response(buildChatStream(web.model, text), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      })
    : Response.json(buildChatCompletion(web.model, text, web.prompt));
}
