// context-file.ts — el contexto del chat vive en un .txt local y el modelo lo
// lee a rebanadas con una tool `read` (read-only, enjaulada a esta carpeta), en
// vez de recibir todo el texto en la caja del composer.
//
// Flujo (v1): el bridge escribe el contexto completo en
// ~/.codex-web-http/context/ctx-<key>.txt, manda un contrato corto para leerlo
// por partes (offset/limit), sigue las llamadas read hasta el ACK, y recien
// entonces pide la respuesta final. El texto crece en disco; la caja no.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CONTEXT_SLICE_LINES = 200;
export const CONTEXT_SLICE_MAX_LINES = 400;
export const CONTEXT_SLICE_MAX_BYTES = 10_000;

export interface ReadSlice {
  path: string;
  content: string;
  offset: number;
  next: number;
  total: number;
}

export function contextDir(): string {
  const override = process.env.CODEX_WEB_HTTP_CONTEXT_DIR?.trim();
  return override || join(homedir(), ".codex-web-http", "context");
}

/** Clave estable por conversacion (modelo + system + primer mensaje del usuario). */
export function makeContextKey(model: string, system: string, firstUser: string): string {
  return createHash("sha256")
    .update(`${model}\u0000${system}\u0000${firstUser}`)
    .digest("hex")
    .slice(0, 12);
}

/** Escribe el contexto completo del chat. Devuelve ruta, total de lineas y bytes. */
export function writeContextFile(key: string, text: string): { path: string; total: number; bytes: number } {
  const dir = contextDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `ctx-${key}.txt`);
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  return { path, total: text.split("\n").length, bytes: statSync(path).size };
}

/** Lee una rebanada por lineas, enjaulada a la carpeta de contexto. */
export function readContextSlice(requestedPath: string, offset: number, limit: number): ReadSlice {
  const dir = resolve(contextDir());
  const full = resolve(requestedPath);
  if (full !== dir && !full.startsWith(`${dir}/`)) {
    throw new Error(`read fuera del contexto: ${requestedPath}`);
  }
  const lines = readFileSync(full, "utf8").split("\n");
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, lines.length));
  const wanted = Math.max(1, Math.min(Math.floor(limit) || CONTEXT_SLICE_LINES, CONTEXT_SLICE_MAX_LINES));
  let end = Math.min(start + wanted, lines.length);
  while (end > start + 1) {
    if (Buffer.byteLength(lines.slice(start, end).join("\n"), "utf8") <= CONTEXT_SLICE_MAX_BYTES) break;
    end--;
  }
  return { path: full, content: lines.slice(start, end).join("\n"), offset: start, next: end, total: lines.length };
}

/** Contrato corto que va en la caja: la unica cosa que el modelo necesita saber. */
export function renderContextContract(path: string, total: number, startAt: number): string {
  const args = JSON.stringify({ path, offset: startAt, limit: CONTEXT_SLICE_LINES });
  return [
    "[context-file]",
    `El contexto completo de esta conversacion vive en un archivo local: ${path}`,
    `(${total} lineas en total; te falta leer desde la linea ${startAt}).`,
    "Para leerlo usa la herramienta read. Formato EXACTO de llamada (un solo JSON, sin texto extra):",
    `{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":${JSON.stringify(args)}}}]}`,
    "Reglas:",
    "- Lee en orden con offset creciente; el resultado trae next y total.",
    "- Cuando next == total hayas leido todo: responde exactamente ACK",
    "- Todavia NO respondas la tarea.",
  ].join("\n");
}

export interface ParsedReadCall {
  path: string;
  offset: number;
  limit: number;
}

/** Parsea una llamada read del sobre JSON (directo o en cerca de codigo). */
export function parseReadCall(text: string): ParsedReadCall | null {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    const calls = (parsed as { tool_calls?: unknown })?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const fn = (call as { function?: { name?: unknown; arguments?: unknown } })?.function;
      if (!fn || fn.name !== "read") continue;
      let args: unknown = fn.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { continue; } }
      if (!args || typeof args !== "object") continue;
      const record = args as Record<string, unknown>;
      const path = typeof record.path === "string" ? record.path : "";
      if (!path) continue;
      const offset = Number.isFinite(Number(record.offset)) ? Number(record.offset) : 0;
      const limit = Number.isFinite(Number(record.limit)) ? Number(record.limit) : CONTEXT_SLICE_LINES;
      return { path, offset: Math.max(0, offset), limit };
    }
  }
  return null;
}

/** Resultado de un read, tal como se le manda de vuelta al modelo. */
export function renderReadResult(slice: ReadSlice): string {
  return [
    `read result path=${slice.path} offset=${slice.offset} next=${slice.next} total=${slice.total}:`,
    slice.content,
  ].join("\n");
}

/** Compacta y poda texto de contexto excesivamente largo antes de serializar o escribir. */
export function compactContextText(
  text: string,
  options: { maxLines?: number; keepHeadLines?: number; keepTailLines?: number } = {},
): { text: string; compacted: boolean; originalLines: number; finalLines: number } {
  const maxLines = options.maxLines ?? 500;
  const keepHead = options.keepHeadLines ?? 50;
  const keepTail = options.keepTailLines ?? 200;

  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, compacted: false, originalLines: lines.length, finalLines: lines.length };
  }

  const head = lines.slice(0, keepHead);
  const tail = lines.slice(-keepTail);
  const omitted = lines.length - head.length - tail.length;

  const compactedText = [
    ...head,
    `\n[... Contexto podado: se omitieron ${omitted} líneas intermedias para preservar ventana de contexto ...]\n`,
    ...tail,
  ].join("\n");

  return {
    text: compactedText,
    compacted: true,
    originalLines: lines.length,
    finalLines: head.length + 1 + tail.length,
  };
}

