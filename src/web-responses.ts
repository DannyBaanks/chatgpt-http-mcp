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
import { parseResponsesInput } from "./responses/input";
import { runTaskTurn } from "./responses/task-turn";
import { WebTaskError } from "./responses/selection";
import { CHATGPT_WEB_MODEL_PREFIX } from "./web-models";
import type { AppConfig } from "./config";

const SSE_DONE = "data: [DONE]";
const encoder = new TextEncoder();

export function isWebModel(model: unknown): boolean {
  return typeof model === "string" && model.startsWith(CHATGPT_WEB_MODEL_PREFIX);
}

export interface WebRequest {
  model: string;
  prompt: string;
  stream: boolean;
  declarations: Record<string, unknown>[];
}

/** Preserve Responses task input; local Web chat has a separate contract. */
export function extractPrompt(body: Record<string, unknown>): string {
  return parseResponsesInput(body).prompt;
}

export async function peekWebRequest(req: Request): Promise<WebRequest | null> {
  let body: Record<string, unknown>;
  try {
    body = (await req.clone().json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !isWebModel(body.model)) return null;
  return {
    model: body.model,
    ...parseResponsesInput(body),
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
        id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
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
export function buildWebStream(model: string, text: string, prompt: string, response = buildResponseBody(model, text, prompt)): ReadableStream<Uint8Array> {
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

/** HTTP and WebSocket share the same durable task-bound backend. */
export async function handleWebResponses(req: Request, config: AppConfig, web: WebRequest): Promise<Response> {
  try {
    const body = await req.clone().json();
    const result = await runTaskTurn(req, body, config, buildResponseBody);
    const headers = { "x-isymcp-replayed": result.replayed ? "1" : "0", "cache-control": "no-store" };
    return web.stream ? new Response(buildWebStream(web.model, result.body.output_text, web.prompt, result.body), {
      headers: { ...headers, "content-type": "text/event-stream" },
    }) : Response.json(result.body, { headers });
  } catch (error) {
    if (error instanceof WebTaskError) return errorJson(error.status, error.type, error.message);
    return errorJson(503, "web_task_state_unavailable", "task state or browser preflight could not be completed");
  }
}
