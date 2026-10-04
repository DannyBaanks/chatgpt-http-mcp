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
import { sendWebTurn } from "./web-turn";
import { isWebModel } from "./web-responses";
import type { AppConfig } from "./config";

const encoder = new TextEncoder();
const SSE_DONE = "data: [DONE]";

export interface ChatWebRequest {
  model: string;
  prompt: string;
  stream: boolean;
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
 * Mapea un body chat.completions a {model, prompt, stream}.
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
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "";
    const text = textOf(message.content).trim();
    if (!text) continue;
    if (role === "system") system.push(text);
    else if (role === "user" || role === "assistant") turns.push(`${role}: ${text}`);
    else turns.push(text);
  }
  const prompt = [...system, ...turns].join("\n\n").trim();
  if (!prompt) return null;
  return { model: record.model as string, prompt, stream: record.stream === true };
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
  let result;
  try {
    result = await sendWebTurn(web.prompt, {
      statePath: config.browserStatePath,
      browser: config.browser,
      headed: config.browserHeaded,
      deadlineMs: config.webTurnDeadlineMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const named = /^(web_[a-z_]+)/.exec(message)?.[1];
    const status = named === "web_session_missing" || named === "web_session_expired" ? 503 : 502;
    return errorJson(status, named ?? "web_turn_failed", message);
  }
  if (!result.submitted || !result.text) {
    return errorJson(
      502,
      "web_no_response",
      `el browser no devolvio respuesta (submitted=${result.submitted} ms=${result.ms} url=${result.url})`,
    );
  }
  console.error(
    `[codex-web-http] web chat turn ok: model=${web.model} ms=${result.ms} reused_page=${result.reused} chars=${result.text.length}`,
  );
  return web.stream
    ? new Response(buildChatStream(web.model, result.text), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      })
    : Response.json(buildChatCompletion(web.model, result.text, web.prompt));
}
