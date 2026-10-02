// logs.ts — lectura y exportacion de logs de isymcp.
// Fuentes: el log del tunnel-client y el log del server detached.
// Las lineas del tunnel traen "time" ISO. Las que no tienen timestamp se
// exportan solo cuando no hay filtro de fecha (no se inventa una hora).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LogLine {
  source: string;
  time: string | null;
  text: string;
}

export function logSources(): Array<{ name: string; path: string }> {
  return [
    { name: "tunnel", path: join(homedir(), ".local", "state", "tunnel-client", "logs", "codex-web-http.log") },
    { name: "server", path: join(homedir(), ".codex-web-http", "run", "server.log") },
  ];
}

export function parseTime(line: string): string | null {
  const json = /"time"\s*:\s*"([^"]+)"/.exec(line);
  if (json) return json[1];
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/.exec(line);
  return iso ? iso[0] : null;
}

export function parseBound(raw: string): number {
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) throw new Error(`fecha invalida: ${raw} (usa 2026-10-02T16:00 o 2026-10-02 16:00)`);
  return ms;
}

export function readSource(name: string, path: string): LogLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((text) => text.length > 0)
    .map((text) => ({ source: name, time: parseTime(text), text }));
}

export function readAll(): LogLine[] {
  return logSources().flatMap((source) => readSource(source.name, source.path));
}

export function inWindow(line: LogLine, sinceMs?: number, untilMs?: number): boolean {
  if (sinceMs === undefined && untilMs === undefined) return true;
  if (!line.time) return false;
  const ms = Date.parse(line.time);
  if (Number.isNaN(ms)) return false;
  if (sinceMs !== undefined && ms < sinceMs) return false;
  if (untilMs !== undefined && ms > untilMs) return false;
  return true;
}

export function selectLines(lines: LogLine[], options: { last?: number; sinceMs?: number; untilMs?: number }): LogLine[] {
  const filtered = lines.filter((line) => inWindow(line, options.sinceMs, options.untilMs));
  if (options.last !== undefined && options.last >= 0) return filtered.slice(-options.last);
  return filtered;
}

export function formatLine(line: LogLine): string {
  return `[${line.source}] ${line.time ?? "sin-hora"} ${line.text}`;
}

export function exportLines(lines: LogLine[], outPath: string): { path: string; count: number } {
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, lines.map(formatLine).join("\n") + (lines.length ? "\n" : ""));
  return { path: outPath, count: lines.length };
}

export function defaultExportPath(stamp = new Date().toISOString().replace(/[:.]/g, "-")): string {
  return join(homedir(), ".codex-web-http", "logs", `isymcp-${stamp}.log`);
}

export function listExports(): string[] {
  const dir = join(homedir(), ".codex-web-http", "logs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".log")).sort();
}
