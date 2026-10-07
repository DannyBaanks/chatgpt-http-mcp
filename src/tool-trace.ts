// tool-trace.ts — tarjetas de tool desde la EVIDENCIA (mcp-trace.log), no
// desde lo que el modelo dice que hizo.
//
// Correlacion: cada turno con tools usa su propio token efimero; aqui solo se
// aceptan lineas cuyo token_fp sea el de ese turno, y solo desde el byte en
// que empezo el turno. Nada de "lo que paso en los ultimos N segundos".
//
// Formato de linea (src/mcp/main.ts): "<iso> <evento> <json>".
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "./codex-sessions";

export function tracePath(): string {
  return join(bridgeHome(), "mcp-trace.log");
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
  exit_code?: number;
  duration_ms?: number;
  error?: string;
}

const BOOKKEEPING = new Set(["codex_turn_start", "codex_turn_complete"]);

/**
 * Tarjetas en orden: cada "call" abre una tarjeta (running) y el siguiente
 * "tool.result" de la misma tool la cierra. Llamadas de contabilidad
 * (turn_start/complete) no son tarjetas.
 */
export function toolCards(events: TraceEvent[]): ToolCard[] {
  const cards: ToolCard[] = [];
  for (const e of events) {
    const tool = String(e.data.tool ?? "");
    if (!tool || BOOKKEEPING.has(tool)) continue;
    if (e.event === "call") {
      cards.push({ tool, summary: "", state: "running" });
      continue;
    }
    if (e.event !== "tool.result") continue;
    const d = e.data;
    const summary = typeof d.command === "string" ? d.command
      : Array.isArray(d.files) ? (d.files as unknown[]).map(String).join(", ")
        : typeof d.path === "string" ? `${d.path}${typeof d.bytes === "number" ? ` (${d.bytes} bytes)` : ""}`
          : "";
    const card: ToolCard = {
      tool,
      summary,
      state: d.ok === true && (typeof d.exit_code !== "number" || d.exit_code === 0) && d.timed_out !== true ? "ok" : "failed",
      ...(typeof d.exit_code === "number" ? { exit_code: d.exit_code } : {}),
      ...(typeof d.duration_ms === "number" ? { duration_ms: d.duration_ms } : {}),
      ...(typeof d.error === "string" ? { error: d.error } : d.timed_out === true ? { error: "timeout" } : {}),
    };
    const open = cards.findIndex((c) => c.state === "running" && c.tool === tool);
    if (open >= 0) cards[open] = card;
    else cards.push(card);
  }
  return cards;
}
