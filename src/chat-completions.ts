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
//
// Fase 2 — function calling: si el request trae `tools` (formato OpenAI), el
// bridge agrega el contrato al prompt; el modelo pide funciones con un sobre
// JSON y el bridge lo traduce a `tool_calls`. Las ejecuta la TUI con SUS
// permisos y devuelve los resultados como role:"tool" en el proximo request.
import { sendWebTurn, withWebLock } from "./web-turn";
import { classifyWebError } from "./error-taxonomy";
import { defaultNavigation, loadSession, rememberConversation } from "./sessions";
import { isWebModel } from "./web-responses";
import type { AppConfig } from "./config";
import {
  makeContextKey, parseReadCall, readContextSlice, renderReadResult,
  writeContextFile,
} from "./context-file";
import {
  parseToolCalls, readAssistantToolCalls, readTools, renderToolContract, toolNames,
  type ChatTool, type ChatToolCall,
} from "./chat-tools";

const encoder = new TextEncoder();
const SSE_DONE = "data: [DONE]";

export interface ChatWebRequest {
  model: string;
  prompt: string;
  stream: boolean;
  /** Clave estable por conversacion para el archivo de contexto local. */
  key: string;
  /** Ultimo mensaje del usuario: se repite en el prompt de trabajo para que el
   *  modelo no confunda la fase de ingesta (ACK) con la respuesta. */
  lastUser: string;
  /** Funciones que la TUI puede ejecutar (formato OpenAI). */
  tools: ChatTool[];
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
 * Mapea un body chat.completions a {model, prompt, stream, key, lastUser, tools}.
 * system -> instrucciones al frente; el resto como transcript "role: texto".
 * Devuelve null si no es un turno web valido (modelo ajeno o sin texto).
 */
export function chatBodyToWebRequest(body: unknown): ChatWebRequest | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (!isWebModel(record.model)) return null;
  const messages = record.messages;
  if (!Array.isArray(messages)) return null;
  const tools = readTools(record.tools);
  const system: string[] = [];
  const turns: string[] = [];
  let firstUser = "";
  let lastUser = "";
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "";
    const text = textOf(message.content).trim();
    if (role === "assistant") {
      const calls = readAssistantToolCalls(message.tool_calls);
      if (calls.length) {
        turns.push(`assistant: [tool_calls] ${calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(" | ")}${text ? `\n${text}` : ""}`);
        continue;
      }
    }
    if (!text) continue;
    if (role === "system") system.push(text);
    else if (role === "user") {
      if (!firstUser) firstUser = text;
      lastUser = text;
      turns.push(`user: ${text}`);
    } else if (role === "assistant") {
      turns.push(`assistant: ${text}`);
    } else if (role === "tool") {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      turns.push(`tool${id ? ` (${id})` : ""}: ${text}`);
    } else {
      turns.push(text);
    }
  }
  const prompt = [...system, ...turns].join("\n\n").trim();
  if (!prompt) return null;
  const model = record.model as string;
  return {
    model, prompt, stream: record.stream === true,
    key: makeContextKey(model, system.join("\n"), firstUser),
    lastUser,
    tools,
  };
}

/** chars/4, estimado: el bridge no tiene el tokenizer de Codex. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Objeto `chat.completion` (contrato OpenAI). */
export function buildChatCompletion(
  model: string,
  text: string,
  prompt: string,
  toolCalls: ChatToolCall[] = [],
): Record<string, unknown> {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(text);
  const message = toolCalls.length
    ? { role: "assistant", content: null, tool_calls: toolCalls }
    : { role: "assistant", content: text };
  return {
    id: `chatcmpl-cwh_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
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

/** SSE con UN delta + done. Si hay tool calls, el delta las lleva completas. */
export function buildChatStream(
  model: string,
  text: string,
  toolCalls: ChatToolCall[] = [],
): ReadableStream<Uint8Array> {
  const id = `chatcmpl-cwh_${crypto.randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: unknown, finish: string | null): Uint8Array =>
    encoder.encode(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (toolCalls.length) {
        const deltas = toolCalls.map((call, index) => ({ index, ...call }));
        controller.enqueue(chunk({ role: "assistant", tool_calls: deltas }, null));
        controller.enqueue(chunk({}, "tool_calls"));
      } else {
        controller.enqueue(chunk({ role: "assistant", content: text }, null));
        controller.enqueue(chunk({}, "stop"));
      }
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
  // "Casarse con un link": se reutiliza la conversacion guardada en la sesion
  // (sobrevive reinicios) y se guarda la nueva URL tras cada turno.
  const conversation = loadSession("default");
  const result = await sendWebTurn(web.prompt, {
    statePath: config.browserStatePath,
    conversationUrl: conversation?.conversationUrl ?? undefined,
    navigate: defaultNavigation(conversation),
    browser: config.browser,
    headed: config.browserHeaded,
    deadlineMs: config.webTurnDeadlineMs,
  });
  if (result.url.includes("/c/")) rememberConversation("default", result.url);
  if (!result.submitted) throw new Error(`web_turn_submit_failed: ms=${result.ms} url=${result.url}`);
  if (!result.text) throw new Error(`web_capture_empty: ms=${result.ms} url=${result.url}`);
  return result.text;
}

interface ChatTurnResult {
  text: string;
  toolCalls: ChatToolCall[];
}

/** Transporte clasico + tools: una sola pasada, contrato al final del prompt. */
async function runSingleTurn(web: ChatWebRequest, config: AppConfig): Promise<ChatTurnResult> {
  const prompt = web.tools.length ? `${web.prompt}\n\n${renderToolContract(web.tools)}` : web.prompt;
  const reply = await sendSingleTurn({ ...web, prompt }, config);
  const calls = web.tools.length ? parseToolCalls(reply, toolNames(web.tools)) : [];
  return { text: calls.length ? "" : reply, toolCalls: calls };
}

/** Tool que ejecuta el PUENTE: el modelo lee el contexto local a pedido. */
const BRIDGE_READ_TOOL = "isyco_read_context";

/** Flujo "pull": mensaje CORTO; el modelo LEE el .txt local con la tool del
 *  puente (solo lectura, enjaulada) y recien despues responde o usa las tools
 *  de la TUI. Nada de empujar el texto completo a la caja. */
async function runContextPullFlow(web: ChatWebRequest, config: AppConfig): Promise<ChatTurnResult> {
  const written = writeContextFile(web.key, web.prompt);
  let readFrom = contextReadState.get(web.key) ?? 0;
  if (readFrom > written.total) readFrom = 0;
  const bridgeTool: ChatTool = {
    name: BRIDGE_READ_TOOL,
    description: "Lee el archivo de contexto local de esta conversacion (solo lectura; lo ejecuta el puente, no la TUI). Devuelve lineas con offset/next/total.",
    parameters: { type: "object", properties: { offset: { type: "integer" }, limit: { type: "integer" } } },
  };
  const allTools = [bridgeTool, ...web.tools];
  const allowed = toolNames(allTools);
  const ask = web.lastUser.trim();
  const askTail = ask.length > 1200 ? ask.slice(-1200) : ask;
  const newLines = written.total - readFrom;
  let prompt =
    "[contexto local]\n" +
    `El contexto de esta conversacion vive en el archivo local ${written.path} (${written.total} lineas; ${newLines} nuevas desde la linea ${readFrom}).\n` +
    `Usa la herramienta ${BRIDGE_READ_TOOL} para leerlo por partes (offset/limit; hasta 400 lineas por llamada) ANTES de responder.\n` +
    "Cuando termines de leer, responde al mensaje del usuario en texto plano, o usa las demas herramientas si necesitas.\n" +
    `Mensaje del usuario: ${askTail}\n\n` +
    renderToolContract(allTools);
  let pulled = readFrom;
  let ackRetries = 0;
  for (let round = 0; round < CONTEXT_MAX_ROUNDS; round++) {
    const reply = await sendSingleTurn({ ...web, prompt }, config);
    const calls = parseToolCalls(reply, allowed);
    if (calls.length) {
      const tui = calls.filter((call) => call.function.name !== BRIDGE_READ_TOOL);
      if (tui.length) {
        contextReadState.set(web.key, Math.max(contextReadState.get(web.key) ?? 0, pulled));
        return { text: "", toolCalls: tui };
      }
      const slices: string[] = [];
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; } catch { /* argumentos invalidos: se usa el offset actual */ }
        const offset = Number.isFinite(Number(args.offset)) ? Number(args.offset) : pulled;
        const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 200;
        const slice = readContextSlice(written.path, offset, limit);
        pulled = Math.max(pulled, slice.next);
        slices.push(renderReadResult(slice));
      }
      console.error(`[codex-web-http] context pull read next=${pulled} total=${written.total} round=${round + 1}`);
      prompt = `${slices.join("\n\n")}\n\n(Segui leyendo si te falta contexto; si ya lo tenes, responde al mensaje del usuario o usa una herramienta.)`;
      continue;
    }
    const trimmed = reply.trim();
    if (/^ack[.!]?$/i.test(trimmed) && ackRetries < 2) {
      ackRetries++;
      prompt = `Necesito tu respuesta. Si te falta contexto, usa ${BRIDGE_READ_TOOL} desde la linea ${pulled} de ${written.total}; si ya lo tenes, responde al mensaje del usuario: ${askTail}`;
      continue;
    }
    contextReadState.set(web.key, Math.max(contextReadState.get(web.key) ?? 0, pulled));
    return { text: reply, toolCalls: [] };
  }
  throw new Error("web_context_pull_loop: demasiadas rondas de read");
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
async function runContextFileFlow(web: ChatWebRequest, config: AppConfig): Promise<ChatTurnResult> {
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

  // El prompt de trabajo NO debe empezar con "ACK" ni pedir confirmaciones:
  // la conversacion ya tiene ACKs de la ingesta y el modelo hacia eco.
  const ask = web.lastUser.trim();
  const askTail = ask.length > 1500 ? ask.slice(-1500) : ask;
  const contract = web.tools.length ? `\n\n${renderToolContract(web.tools)}` : "";
  let prompt =
    "El archivo de contexto ya fue ingestado en esta conversacion (las partes anteriores). " +
    "Responde AHORA, en texto plano, al mensaje del usuario. No respondas ACK ni repitas estas instrucciones: da la respuesta final.\n" +
    `Mensaje del usuario: ${askTail}${contract}`;
  const allowed = toolNames(web.tools);
  let ackRetries = 0;
  for (let round = 0; round < CONTEXT_MAX_ROUNDS; round++) {
    const reply = await sendSingleTurn({ ...web, prompt }, config);
    const read = parseReadCall(reply);
    if (read) {
      const slice = readContextSlice(read.path, read.offset, read.limit);
      contextReadState.set(web.key, Math.max(contextReadState.get(web.key) ?? 0, slice.next));
      prompt = renderReadResult(slice);
      continue;
    }
    const calls = web.tools.length ? parseToolCalls(reply, allowed) : [];
    if (calls.length) return { text: "", toolCalls: calls };
    const trimmed = reply.trim();
    if (/^ack[.!]?$/i.test(trimmed) && ackRetries < 2) {
      ackRetries++;
      prompt =
        "Tu respuesta anterior fue solo 'ACK', que no es una respuesta. Necesito la RESPUESTA FINAL al mensaje del usuario: " +
        `${askTail || "el ultimo mensaje del contexto"}. No respondas ACK.`;
      continue;
    }
    return { text: reply, toolCalls: [] };
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
  let turn: ChatTurnResult;
  try {
    // El candado cubre la request entera: las rondas de un flujo no se
    // intercalan con las de otra request en la misma conversacion.
    turn = await withWebLock(() =>
      config.contextMode === "pull" ? runContextPullFlow(web, config)
        : config.contextMode === "push" ? runContextFileFlow(web, config)
          : runSingleTurn(web, config));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { type, status } = classifyWebError(message);
    console.error(
      `[codex-web-http] chat turn FAILED: ${type} context=${config.contextMode} tools=${web.tools.length} deadline_ms=${config.webTurnDeadlineMs} :: ${message}`,
    );
    return errorJson(status, type, message);
  }
  console.error(
    `[codex-web-http] web chat turn ok: model=${web.model} context=${config.contextMode} tool_calls=${turn.toolCalls.length} chars=${turn.text.length}`,
  );
  return web.stream
    ? new Response(buildChatStream(web.model, turn.text, turn.toolCalls), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      })
    : Response.json(buildChatCompletion(web.model, turn.text, web.prompt, turn.toolCalls));
}
