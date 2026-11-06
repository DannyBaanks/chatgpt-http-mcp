// tool-trace.ts — tarjetas de tool desde la EVIDENCIA (mcp-trace.log), no
// desde lo que el modelo dice que hizo.
//
// Correlacion: cada turno con tools usa su propio token efimero; aqui solo se
// aceptan lineas cuyo token_fp sea el de ese turno, y solo desde el byte en
// que empezo el turno. Nada de "lo que paso en los ultimos N segundos".
//
// Formato de linea (src/mcp/main.ts): "<iso> <evento> <json>".
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "./codex-sessions";

export function tracePath(): string {
  return join(bridgeHome(), "mcp-trace.log");
}

/**
 * Escribe una linea de traza (JSONL, 0600) saneada. Nunca lanza: la traza no
 * debe romper ningun server. Compartida por el MCP principal y el de medios.
 */
export function appendTrace(event: string, detail: Record<string, unknown>, path = tracePath()): void {
  try {
    mkdirSync(bridgeHome(), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${event} ${JSON.stringify(sanitizeToolTraceValue(detail))}\n`, { mode: 0o600 });
  } catch {
    /* la traza nunca debe romper el server */
  }
}

export function traceSize(path = tracePath()): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

export interface TraceEvent {
  ts: string;
  event: string;
  data: Record<string, unknown>;
}

/** Eventos de `fp` escritos despues de `offset` (bytes). */
export function readTraceSince(offset: number, fp: string, path = tracePath()): TraceEvent[] {
  if (!existsSync(path)) return [];
  const size = traceSize(path);
  if (size <= offset) return [];
  const fd = openSync(path, "r");
  let text = "";
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const out: TraceEvent[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\S+) (\S+) (\{.*\})$/.exec(line);
    if (!m) continue;
    try {
      const data = JSON.parse(m[3]!) as Record<string, unknown>;
      if (data.token_fp === fp) out.push({ ts: m[1]!, event: m[2]!, data });
    } catch {
      /* linea a medio escribir: se relee en el siguiente sondeo */
    }
  }
  return out;
}

export interface ToolCard {
  tool: string;
  /** Lo que se ejecuto (comando, archivos, ruta). */
  summary: string;
  state: "running" | "ok" | "failed";
  /** No revela el ID; indica si el comprobante tuvo correlacion exacta. */
  correlation: "exact" | "legacy";
  exit_code?: number;
  duration_ms?: number;
  error?: string;
}

const LABELED_CREDENTIAL = new RegExp(
  String.raw`(["']?)([A-Za-z0-9_.-]*(?:token|secret|password|credential|authorization|api[_-]?key|private[_-]?key|client[_-]?key)[A-Za-z0-9_.-]*)` +
    String.raw`\1\s*[:=]\s*(?:Bearer\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)`,
  "gi",
);
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_CREDENTIAL = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const OUTPUT_FIELD = /^(?:stdout|stderr)$/i;

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[\s_-]/g, "");
  return /^(?:(?:turn|session|access|refresh)?token|secret|password|credential|authorization|auth(?:key|token|secret|credential)?)$/.test(normalized)
    || normalized.includes("secret")
    || normalized.includes("privatekey")
    || normalized.includes("clientkey")
    || /^(?:openai)?api(?:key|token|secret|credential)?$/.test(normalized);
}

function redactCredentialText(value: string): string {
  return value
    .replace(LABELED_CREDENTIAL, (_match, _quote: string, label: string) => `${label}=[redacted]`)
    .replace(BEARER_CREDENTIAL, "Bearer [redacted]")
    .replace(JWT_CREDENTIAL, "[credential redacted]");
}

function redactStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (OUTPUT_FIELD.test(key)) out[key] = `[${key.toLowerCase()} redacted]`;
      else if (isCredentialKey(key)) out[key] = "[credential redacted]";
      else out[key] = redactStructuredValue(child);
    }
    return out;
  }
  if (typeof value === "string") {
    return redactCredentialText(value);
  }
  return value;
}

/** Find a balanced JSON object/array without mistaking braces inside strings. */
function jsonValueEnd(text: string, start: number): number | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const opening = stack.pop();
      if ((char === "}" && opening !== "{") || (char === "]" && opening !== "[")) return undefined;
      if (stack.length === 0) return i;
    }
  }
  return undefined;
}

/** Redact JSON values embedded in otherwise ordinary receipt text. */
function redactSerializedJson(text: string): string {
  let out = "";
  let copiedThrough = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const end = jsonValueEnd(text, i);
    if (end === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(i, end + 1));
      out += text.slice(copiedThrough, i) + JSON.stringify(redactStructuredValue(parsed));
      copiedThrough = end + 1;
      i = end;
    } catch {
      // Keep arbitrary command fragments intact; a nested JSON value may
      // still be recognized by a later iteration.
    }
  }
  return copiedThrough ? out + text.slice(copiedThrough) : text;
}

function sanitizeReceiptText(value: string): string {
  return sanitizeToolTraceText(value);
}

/** Sanitize free text before it crosses a persistent trace or receipt boundary. */
export function sanitizeToolTraceText(value: string): string {
  return redactCredentialText(redactSerializedJson(value));
}

/** Recursively sanitize structured data before writing it to the raw trace. */
export function sanitizeToolTraceValue(value: unknown): unknown {
  return redactStructuredValue(value);
}

/** Browser/persistence boundary for new and already-saved receipt shapes. */
export function publicToolCard(value: unknown): ToolCard | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = value as Record<string, unknown>;
  if (typeof card.tool !== "string" || typeof card.summary !== "string") return null;
  if (card.state !== "running" && card.state !== "ok" && card.state !== "failed") return null;
  const correlation = card.correlation === "exact" ? "exact" : "legacy";
  return {
    tool: card.tool,
    summary: sanitizeReceiptText(card.summary),
    state: card.state,
    correlation,
    ...(typeof card.exit_code === "number" && Number.isFinite(card.exit_code) ? { exit_code: card.exit_code } : {}),
    ...(typeof card.duration_ms === "number" && Number.isFinite(card.duration_ms) ? { duration_ms: card.duration_ms } : {}),
    ...(typeof card.error === "string" ? { error: sanitizeReceiptText(card.error) } : {}),
  };
}

const BOOKKEEPING = new Set(["codex_turn_start", "codex_turn_complete"]);

/**
 * Empareja eventos nuevos por call_id, conservado solo dentro de esta
 * proyeccion. Trazas antiguas sin ID se mantienen con la correlacion FIFO
 * historica por herramienta. Llamadas de contabilidad no son tarjetas.
 */
export function toolCards(events: TraceEvent[]): ToolCard[] {
  const cards: Array<{ callId?: string; card: ToolCard }> = [];
  const byCallId = new Map<string, number>();
  const legacyOpenByTool = new Map<string, number[]>();
  for (const e of events) {
    const tool = typeof e.data.tool === "string" ? e.data.tool : "";
    if (!tool || BOOKKEEPING.has(tool)) continue;
    if (e.event === "call") {
      const callId = typeof e.data.call_id === "string" && e.data.call_id ? e.data.call_id : undefined;
      const index = cards.push({ callId, card: { tool, summary: "", state: "running", correlation: callId ? "exact" : "legacy" } }) - 1;
      if (callId) byCallId.set(callId, index);
      else {
        const open = legacyOpenByTool.get(tool) ?? [];
        open.push(index);
        legacyOpenByTool.set(tool, open);
      }
      continue;
    }
    if (e.event !== "tool.result") continue;
    const d = e.data;
    const summary = typeof d.command === "string" ? d.command
      : Array.isArray(d.files) ? (d.files as unknown[]).map(String).join(", ")
        : typeof d.path === "string" ? `${d.path}${typeof d.bytes === "number" ? ` (${d.bytes} bytes)` : ""}`
          : "";
    const callId = typeof d.call_id === "string" && d.call_id ? d.call_id : undefined;
    const card: ToolCard = {
      tool,
      summary,
      state: d.ok === true && (typeof d.exit_code !== "number" || d.exit_code === 0) && d.timed_out !== true ? "ok" : "failed",
      correlation: callId ? "exact" : "legacy",
      ...(typeof d.exit_code === "number" && Number.isFinite(d.exit_code) ? { exit_code: d.exit_code } : {}),
      ...(typeof d.duration_ms === "number" && Number.isFinite(d.duration_ms) ? { duration_ms: d.duration_ms } : {}),
      ...(typeof d.error === "string" ? { error: d.error } : d.timed_out === true ? { error: "timeout" } : {}),
    };
    let index = callId ? byCallId.get(callId) : undefined;
    if (index !== undefined && cards[index]?.card.tool !== tool) index = undefined;
    if (index === undefined && !callId) {
      const legacyOpen = legacyOpenByTool.get(tool);
      while (legacyOpen?.length && cards[legacyOpen[0]!]?.card.state !== "running") legacyOpen.shift();
      index = legacyOpen?.shift();
    }
    if (index !== undefined) {
      const prior = cards[index]!;
      cards[index] = { ...prior, card };
      if (prior.callId) byCallId.delete(prior.callId);
    } else {
      // A result whose call is outside this trace slice still remains visible.
      cards.push({ callId, card });
    }
  }
  // The internal call ID is intentionally not part of the browser or
  // persisted receipt shape; correlation only preserves its confidence.
  return cards.map(({ card }) => publicToolCard(card)!).filter(Boolean);
}
