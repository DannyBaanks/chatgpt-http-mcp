// sessions.ts — una sesion = unas cookies + una conversacion.
// No abre un chat nuevo en cada turno: si ya hay URL /c/, se reutiliza.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalConversationUrl, type WebNavigation } from "./web-turn";

export interface SessionRecord {
  name: string;
  statePath: string;
  conversationUrl: string | null;
  updatedAt: string;
}

export function sessionsDir(): string {
  return join(homedir(), ".codex-web-http", "sessions");
}

export function sessionPath(name: string): string {
  return join(sessionsDir(), `${name}.json`);
}

export function loadSession(name = "default"): SessionRecord | null {
  const path = sessionPath(name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
}

export function saveSession(record: SessionRecord): void {
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(sessionPath(record.name), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
}

/** Copia las cookies ya extraidas a una sesion nombrada. No abre el browser. */
export function bindCookies(name: string, sourceState: string): SessionRecord {
  if (!existsSync(sourceState)) {
    throw new Error(`no hay cookies en ${sourceState}`);
  }
  const dir = join(sessionsDir(), name);
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, "storage-state.json");
  copyFileSync(sourceState, statePath);
  const previous = loadSession(name);
  const record: SessionRecord = {
    name,
    statePath,
    conversationUrl: previous?.conversationUrl ?? null,
    updatedAt: new Date().toISOString(),
  };
  saveSession(record);
  return record;
}

export function rememberConversation(name: string, url: string): void {
  if (!url.includes("/c/")) return;
  const current = loadSession(name);
  if (!current) return;
  saveSession({ ...current, conversationUrl: url, updatedAt: new Date().toISOString() });
}

/**
 * A donde debe ir la pestana compartida antes de un turno de la ruta
 * OpenAI-compatible: su conversacion "casada". Antes la pestana solo podia
 * estar ahi; ahora el chat del panel la mueve a otros /c/, asi que sin esto un
 * turno de opencode podria caer en un chat del panel.
 *   - con /c/ recordado      -> volver a el (no navega si ya esta ahi);
 *   - registro sin /c/ aun   -> conversacion nueva (como al lanzar Chrome);
 *   - sin registro default   -> comportamiento historico (no navega).
 */
export function defaultNavigation(record: SessionRecord | null): WebNavigation | undefined {
  if (!record) return undefined;
  const url = canonicalConversationUrl(record.conversationUrl);
  return url ? { to: "conversation", url } : { to: "new" };
}
