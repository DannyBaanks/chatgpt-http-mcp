// web-responses.ts — M7: POST /v1/responses con modelo chatgpt-web/*.
//
// Aqui es donde el selector nativo de Codex se vuelve real: si el modelo
// pedido es una fila Web, la llamada NO va a Electron ni a api.openai.com;
// va al browser persistente (src/web-turn.ts) contra ChatGPT.
//
// Honestidad sobre el streaming: la fuente (DOM de ChatGPT) no emite tokens de
// forma incremental, asi que en stream=true el texto completo sale como UN
// delta seguido de response.completed. El protocolo se cumple, la granularidad
// no se inventa. Los conteos de usage son ESTIMADOS (chars/4): no hay
// tokenizer de Codex aqui, y un numero inventado con precision falsa es peor
// que uno aproximado y rotulado.
import { sendWebTurn } from "./web-turn";
import { CHATGPT_WEB_MODEL_PREFIX, routeEfforts, availableRoutes } from "./web-models";
import type { AppConfig } from "./config";

const SSE_DONE = "data: [DONE]";
const encoder = new TextEncoder();

export function isWebModel(model: unknown): boolean {
  return typeof model === "string" && model.startsWith(CHATGPT_WEB_MODEL_PREFIX);
}

interface WebRequest {
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
 * Extrae el prompt del body de Responses. Tolera `input` como string o como
 * lista de items de mensaje (content string o partes input_text/output_text),
 * y antepone `instructions` como el reference hace.
 */
export function extractPrompt(body: Record<string, unknown>): string {
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  const input = body.input;
  let turn = "";
  if (typeof input === "string") {
    turn = input;
  } else if (Array.isArray(input)) {
    turn = input
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        if (typeof record.text === "string" && record.type !== "message") return record.text;
        const role = typeof record.role === "string" ? record.role : "";
        const inner = textOf(record.content);
        if (!inner) return "";
        // El eco del usuario no aporta: el browser ya tiene la conversacion.
        return role === "user" ? "" : inner;
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return instructions ? `${instructions}\n\n${turn}` : turn;
}

export async function peekWebRequest(req: Request): Promise<WebRequest | null> {
  let body: Record<string, unknown>;
  try {
    body = (await req.clone().json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!isWebModel(body.model)) return null;
  return {
    model: body.model,
    prompt: extractPrompt(body),
    stream: body.stream === true,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Cuerpo de Responses no-streaming (contrato `object: "response"`). */
export function buildResponseBody(model: string, text: string, prompt: string): Record<string, unknown> {
  const inputTokens = estimateTokens(prompt);
  const outputTokens = estimateTokens(text);
  return {
    id: `resp_cwh_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    output_text: text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function sseEvent(type: string, payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

/** SSE del mismo cuerpo: UN delta con el texto completo, luego completed. */
export function buildWebStream(model: string, text: string, prompt: string): ReadableStream<Uint8Array> {
  const response = buildResponseBody(model, text, prompt);
  const { output, output_text: _outputText, ...rest } = response;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseEvent("response.created", { response: rest }));
      controller.enqueue(sseEvent("response.output_text.delta", { delta: text }));
      controller.enqueue(sseEvent("response.output_text.done", { text }));
      controller.enqueue(sseEvent("response.completed", { response }));
      controller.enqueue(encoder.encode(`${SSE_DONE}\n\n`));
      controller.close();
    },
  });
}

function errorJson(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

/** effort pedido vs disponible para esa fila; no inventa capacidades. */
function effortNote(config: AppConfig, model: string, requested: unknown): string | undefined {
  const route = availableRoutes(config.capabilities).find((r) => r.slug === model);
  if (!route) return undefined;
  const allowed = routeEfforts(route, config.capabilities);
  return allowed.includes(requested as never) ? undefined : `effort pedido=${String(requested)} disponible=${allowed.join(",")}`;
}

/** Atiende un POST /v1/responses con modelo Web. */
export async function handleWebResponses(
  req: Request,
  config: AppConfig,
  web: WebRequest,
): Promise<Response> {
  if (!web.prompt.trim()) {
    return errorJson(400, "web_empty_input", "no se extrajo texto del input para el turno web");
  }
  let note: string | undefined;
  let body: Record<string, unknown> = {};
  try {
    body = (await req.clone().json()) as Record<string, unknown>;
    note = effortNote(config, web.model, body.reasoning?.effort ?? body.reasoning_effort);
  } catch {
    /* ya se parseo en peek; si falla, el prompt ya viene en web.prompt */
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
  if (note) {
    console.error(`[codex-web-http] ${web.model}: ${note}`);
  }
  console.error(
    `[codex-web-http] web turn ok: model=${web.model} ms=${result.ms} reused_page=${result.reused} chars=${result.text.length}`,
  );

  return web.stream
    ? new Response(buildWebStream(web.model, result.text, web.prompt), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      })
    : Response.json(buildResponseBody(web.model, result.text, web.prompt));
}