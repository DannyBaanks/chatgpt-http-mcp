// src/taint.ts — "El modelo ya leyó contenido externo" (sesión contaminada).
//
// Cuando una herramienta de ISyMCP le entrega al modelo texto o imágenes que no escribió el operador
// (issues/PRs/API de GitHub, metadatos, transcripciones o fotogramas de un medio importado), ese
// contenido puede traer instrucciones escondidas. A partir de ahí los permisos amplios (`isymcp allow
// ... on`, variables de entorno) ya no bastan para shell y consolas: cada uso necesita un permiso de un
// solo uso del operador (`isymcp allow once ...`) o un OperatorGrant del Control Center.
//
// Límites (a propósito, documentados):
//   - ISyMCP solo ve lo que entra por SUS herramientas. La búsqueda web y la lectura de páginas que
//     ChatGPT hace por su cuenta no pasan por aquí y no contaminan.
//   - No contaminan: la salida de shell_exec y de las consolas (ya están detrás de la puerta), el
//     monitor (tareas entre agentes) ni github_status/whoami (perfil propio).
//
// Estado en ~/.codex-web-http/taint.json (0600), compartido por todos los procesos (server, broker,
// gateway de Claude Code). Caduca solo (TAINT_TTL_MS desde la última lectura externa) o con
// `isymcp taint clear`. ISYMCP_TAINT_GATE=0 en el entorno del server apaga el efecto sobre la puerta.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "./codex-sessions";

/** Cuánto dura la contaminación desde la ÚLTIMA lectura externa. */
export const TAINT_TTL_MS = 2 * 3600_000;
const MAX_SOURCES = 10;

export interface TaintSource {
  tool: string;
  at: string;
  detail?: string;
}

export interface TaintState {
  since: string;
  until: string;
  sources: TaintSource[];
}

type Env = Record<string, string | undefined>;

export function taintPath(env: Env = process.env): string {
  return join(bridgeHome(env), "taint.json");
}

function readState(env: Env): TaintState | null {
  const path = taintPath(env);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data !== "object" || typeof data.until !== "string") return null;
    return { since: String(data.since ?? data.until), until: data.until, sources: Array.isArray(data.sources) ? data.sources : [] };
  } catch {
    // Ilegible: cuenta como contaminado (fail-closed) hasta que el operador lo limpie.
    const now = new Date().toISOString();
    return { since: now, until: new Date(Date.now() + TAINT_TTL_MS).toISOString(), sources: [{ tool: "taint.json ilegible", at: now }] };
  }
}

/** Contaminación vigente, o null. Una fecha ilegible cuenta como vigente. */
export function activeTaint(env: Env = process.env, now = Date.now()): TaintState | null {
  const state = readState(env);
  if (!state) return null;
  const until = Date.parse(state.until);
  if (Number.isFinite(until) && until <= now) return null;
  return state;
}

/** Si la contaminación cierra la puerta. ISYMCP_TAINT_GATE=0 (operador) lo apaga. */
export function taintGateEnabled(env: Env = process.env): boolean {
  return env.ISYMCP_TAINT_GATE !== "0";
}

/**
 * Marca que el modelo recibió contenido externo por `tool`. Extiende la caducidad. Nunca lanza:
 * una marca fallida no rompe la herramienta (pero sí se intenta en cada llamada).
 */
export function markTainted(tool: string, detail?: string, env: Env = process.env, now = Date.now()): void {
  // Las pruebas sin home aislado no tocan el estado real del operador.
  if (env.NODE_ENV === "test" && !env.CODEX_WEB_HTTP_HOME) return;
  try {
    const prev = activeTaint(env, now);
    const at = new Date(now).toISOString();
    const src: TaintSource = { tool, at, ...(detail ? { detail: detail.length > 200 ? `${detail.slice(0, 197)}...` : detail } : {}) };
    const next: TaintState = {
      since: prev?.since ?? at,
      until: new Date(now + TAINT_TTL_MS).toISOString(),
      sources: [...(prev?.sources ?? []), src].slice(-MAX_SOURCES),
    };
    const home = bridgeHome(env);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const path = taintPath(env);
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch {
    /* sin marca no se rompe la herramienta */
  }
}

/** Limpia la contaminación (decisión del operador: `isymcp taint clear`). */
export function clearTaint(env: Env = process.env): boolean {
  const path = taintPath(env);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** "github.issues hace 3 min" — para mensajes y avisos. */
export function describeTaint(state: TaintState, now = Date.now()): string {
  const last = state.sources[state.sources.length - 1];
  if (!last) return "contenido externo";
  const mins = Math.max(0, Math.round((now - Date.parse(last.at)) / 60_000));
  return `${last.tool}${last.detail ? ` (${last.detail})` : ""} hace ${mins} min`;
}
