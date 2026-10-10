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

/**
 * Secuencia de eventos Responses completa para UN mensaje de texto:
 * created -> in_progress -> output_item.added -> content_part.added ->
 * output_text.delta -> output_text.done -> content_part.done ->
 * output_item.done -> completed.
 *
 * El Codex CLI real descarta un delta que llega sin su item anunciado
 * ("OutputTextDelta without active item", visto 2026-10-07 en el gate M8):
 * por eso el item y la parte se anuncian antes y se cierran despues. HTTP (SSE)
 * y WebSocket usan esta misma funcion para no divergir.
 */
export function responseEvents(response: Record<string, unknown>, text: string): Array<Record<string, unknown>> {
  const message = (response.output as Array<Record<string, unknown>>)[0]!;
  const itemId = message.id as string;
  const { output: _output, output_text: _outputText, ...rest } = response;
  const pending = { ...rest, status: "in_progress", output: [] };
  if (message.type === "function_call" || message.type === "custom_tool_call") {
    const field = message.type === "function_call" ? "arguments" : "input";
    const prefix = message.type === "function_call" ? "response.function_call_arguments" : "response.custom_tool_call_input";
    return [
      { type: "response.created", response: pending },
      { type: "response.in_progress", response: pending },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", [field]: "" } },
      { type: `${prefix}.delta`, item_id: itemId, output_index: 0, delta: message[field] },
      { type: `${prefix}.done`, item_id: itemId, output_index: 0, [field]: message[field] },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response },
    ].map((event, sequence_number) => ({ ...event, sequence_number }));
  }
  const part = { type: "output_text", text, annotations: [] };
  const at = { item_id: itemId, output_index: 0, content_index: 0 };
  const events: Array<Record<string, unknown>> = [
    { type: "response.created", response: pending },
    { type: "response.in_progress", response: pending },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.content_part.added", ...at, part: { ...part, text: "" } },
    { type: "response.output_text.delta", ...at, delta: text },
    { type: "response.output_text.done", ...at, text },
    { type: "response.content_part.done", ...at, part },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ];
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}

/** SSE del mismo cuerpo: UN delta con el texto completo, dentro de su item. */
export function buildWebStream(model: string, text: string, prompt: string, response = buildResponseBody(model, text, prompt)): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const { type, ...payload } of responseEvents(response, text)) controller.enqueue(sseEvent(type as string, payload));
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
