// ws-responses.ts — Codex abre ws://host/v1/responses, no un POST.
// Si contestamos 405, Codex reintenta contra la cuenta de ChatGPT y esa
// rechaza el slug chatgpt-web/*. El turno tiene que quedarse aca.
import { parseResponsesInput } from "./responses/input";
import { buildResponseBody, isWebModel, responseEvents } from "./web-responses";

export interface WsTurn {
  body: Record<string, unknown>;
  model: string;
  prompt: string;
  web: boolean;
  declarations: Record<string, unknown>[];
}

export function parseWsTurn(raw: string): WsTurn | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (body.type === "response.create" && body.response && typeof body.response === "object") {
    body = body.response as Record<string, unknown>;
  }
  const model = typeof body.model === "string" ? body.model : "";
  if (!model) return null;
  // Native requests never enter the Web parser; their rejection/routing stays unchanged.
  if (!isWebModel(model)) return { model, prompt: "", web: false, declarations: [], body };
  return { model, ...parseResponsesInput(body), web: true, body };
}

/** Una linea JSON por evento. Eso es lo unico que Codex tiene que leer. */
export function toJsonl(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

/** Mismos eventos que el SSE (ver responseEvents): item anunciado antes del delta. */
export function wsFrames(model: string, text: string, response = buildResponseBody(model, text, "")): string[] {
  return responseEvents(response, text).map((event) => JSON.stringify(event));
}
