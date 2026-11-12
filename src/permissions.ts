// src/permissions.ts — Permisos del operador para lo que ejecuta código en el host.
//
// Dos capacidades, CERRADAS por defecto (fail-closed):
//   host_shell   shell_exec / shell.exec: bash en el host sin sandbox.
//   agent_spawn  abrir consolas de agentes (spawn_agy_tui, spawn_agent_tui, tui.spawn) y pegarles
//                tareas (monitor.submit + console_id). Un agente con prompt = ejecutar código.
//
// Se habilitan por cualquiera de estas vías (todas del operador, nunca del modelo):
//   1. Variable de entorno del proceso: ISYMCP_ALLOW_HOST_SHELL=1 / ISYMCP_ALLOW_AGENT_SPAWN=1.
//   2. ~/.codex-web-http/permissions.json (0600), escrito por `isymcp allow ...`. Se lee en CADA llamada:
//      encender/apagar no requiere reiniciar el server ni el túnel. Caduca solo (`<cap>_until`):
//      por defecto DEFAULT_TTL_MS; `--forever` lo deja sin caducidad a propósito.
//   3. Un OperatorGrant de un solo uso del Control Center (runWithOperatorAuthorization).
//
// Por qué: el modelo puede leer contenido externo (webs, repos, issues) con instrucciones escondidas.
// Lo que ejecuta código queda detrás de una decisión explícita del operador.
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "./codex-sessions";

export type Capability = "host_shell" | "agent_spawn";
export const CAPABILITIES: Capability[] = ["host_shell", "agent_spawn"];

const ENV_VAR: Record<Capability, string> = {
  host_shell: "ISYMCP_ALLOW_HOST_SHELL",
  agent_spawn: "ISYMCP_ALLOW_AGENT_SPAWN",
};

export function capabilityEnvVar(cap: Capability): string {
  return ENV_VAR[cap];
}

const operatorAuth = new AsyncLocalStorage<{ authorized: true }>();

/** Marca el contexto async actual como autorizado por un OperatorGrant ya consumido. */
export function runWithOperatorAuthorization<T>(fn: () => T): T {
  return operatorAuth.run({ authorized: true }, fn);
}

export function permissionsPath(env: Record<string, string | undefined> = process.env): string {
  return join(bridgeHome(env), "permissions.json");
}

interface PermissionsFile {
  host_shell?: boolean;
  agent_spawn?: boolean;
  /** ISO: hasta cuándo vale el permiso del archivo; ausente = sin caducidad. */
  host_shell_until?: string;
  agent_spawn_until?: string;
  updated_at?: string;
}

/** Duración por defecto de `isymcp allow <cap> on` (sin --for ni --forever). */
export const DEFAULT_TTL_MS = 12 * 3600_000;
/** Máximo para --for: más que eso es --forever, y debe pedirse a propósito. */
export const MAX_TTL_MS = 24 * 3600_000;

/** "30m", "2h", "1d", "90s" -> ms; null si no se entiende. */
export function parseDuration(raw: string | undefined): number | null {
  const m = String(raw ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[m[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
  const ms = Math.round(n * unit);
  return ms > 0 ? ms : null;
}

export interface FileGrant {
  on: boolean;
  until: string | null;
  expired: boolean;
}

/** Estado del permiso en el archivo, con caducidad aplicada. */
export function fileGrant(cap: Capability, env: Record<string, string | undefined> = process.env, now = Date.now()): FileGrant {
  const data = readFile(env);
  const until = typeof data[`${cap}_until`] === "string" ? (data[`${cap}_until`] as string) : null;
  const untilMs = until ? Date.parse(until) : NaN;
  // Una fecha ilegible cuenta como caducada: cerrado.
  const expired = until !== null && (!Number.isFinite(untilMs) || untilMs <= now);
  return { on: data[cap] === true && !expired, until, expired: data[cap] === true && expired };
}

function readFile(env: Record<string, string | undefined>): PermissionsFile {
  const path = permissionsPath(env);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {}; // ilegible = cerrado
  }
}

export type PermissionSource = "env" | "file" | "operator_grant" | null;

/** Quién habilita la capacidad ahora mismo (null = cerrada). Solo `true` literal cuenta. */
export function permissionSource(cap: Capability, env: Record<string, string | undefined> = process.env): PermissionSource {
  if (env[ENV_VAR[cap]] === "1") return "env";
  if (fileGrant(cap, env).on) return "file";
  if (operatorAuth.getStore()?.authorized === true) return "operator_grant";
  return null;
}

export function permissionEnabled(cap: Capability, env: Record<string, string | undefined> = process.env): boolean {
  return permissionSource(cap, env) !== null;
}

/**
 * Enciende/apaga en el archivo. `ttlMs`: undefined = DEFAULT_TTL_MS; null = sin caducidad (--forever).
 * Apagar borra la caducidad.
 */
export function setPermission(
  cap: Capability,
  on: boolean,
  env: Record<string, string | undefined> = process.env,
  ttlMs?: number | null,
): PermissionsFile {
  const home = bridgeHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const next: PermissionsFile = { ...readFile(env), [cap]: on, updated_at: new Date().toISOString() };
  const ttl = ttlMs === undefined ? DEFAULT_TTL_MS : ttlMs;
  if (on && ttl !== null) next[`${cap}_until`] = new Date(Date.now() + ttl).toISOString();
  else delete next[`${cap}_until`];
  const path = permissionsPath(env);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return next;
}

export function deniedMessage(cap: Capability): string {
  const what = cap === "host_shell" ? "shell_exec ejecuta en el host sin sandbox" : "abrir o escribir en consolas de agentes ejecuta código en el host";
  const allow = cap === "host_shell" ? "shell" : "agents";
  return `DENIED: ${what}; el operador lo habilita con \`isymcp allow ${allow} on\` (o ${ENV_VAR[cap]}=1)`;
}

// ─── Puerta única: decide, registra y avisa ──────────────────────────────────

export interface GateDecision {
  ok: boolean;
  source: PermissionSource;
  message?: string;
}

export function auditLogPath(env: Record<string, string | undefined> = process.env): string {
  return join(bridgeHome(env), "audit", "gates.jsonl");
}

/** Detalle para la bitácora: valores cortos, sin nada que parezca credencial. */
function auditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined || v === null || SECRET_ENV.test(k)) continue;
    out[k] = typeof v === "string" ? (v.length > 300 ? `${v.slice(0, 297)}...` : v) : v;
  }
  return out;
}

/** Bitácora append-only (0600). Nunca rompe la operación. */
export function appendAudit(entry: Record<string, unknown>, env: Record<string, string | undefined> = process.env): void {
  // Las pruebas sin home aislado no ensucian la bitácora real del operador.
  if (env.NODE_ENV === "test" && !env.CODEX_WEB_HTTP_HOME) return;
  try {
    const path = auditLogPath(env);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* sin bitácora no se bloquea la operación */
  }
}

export function readAudit(last = 20, env: Record<string, string | undefined> = process.env): Array<Record<string, unknown>> {
  const path = auditLogPath(env);
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* línea rota: se ignora */ }
  }
  return rows.slice(-Math.max(1, Math.min(1000, Math.trunc(last) || 20)));
}

/** Aviso de escritorio (best effort, sin bloquear). Nunca en tests ni sin pantalla; ISYMCP_NOTIFY=0 lo apaga. */
export function notifyOperator(title: string, body: string, env: Record<string, string | undefined> = process.env): void {
  if (env.ISYMCP_NOTIFY === "0" || env.NODE_ENV === "test" || process.platform !== "linux") return;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return;
  const bin = Bun.which("notify-send", { PATH: env.PATH ?? "" });
  if (!bin) return;
  try {
    spawn(bin, ["--app-name=ISyMCP", "--icon=dialog-warning", title, body.slice(0, 300)], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* sin aviso no se bloquea */
  }
}

/**
 * La ÚNICA puerta para lo que ejecuta código en nombre del modelo: decide con permissionSource,
 * deja registro en la bitácora y, si se permite abrir/escribir en una consola, avisa al operador.
 */
export function checkGate(
  cap: Capability,
  action: string,
  detail: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
): GateDecision {
  const source = permissionSource(cap, env);
  const ok = source !== null;
  const expired = !ok && fileGrant(cap, env).expired;
  appendAudit({ cap, action, decision: ok ? "allow" : "deny", source, ...(expired ? { reason: "expired" } : {}), ...auditDetail(detail) }, env);
  if (ok && cap === "agent_spawn") {
    const who = typeof detail.agent === "string" ? detail.agent : typeof detail.console_id === "string" ? detail.console_id : "";
    notifyOperator(`ISyMCP: ${action}`, `${who ? `${who} · ` : ""}permiso por ${source}. Bitácora: isymcp allow log`, env);
  }
  if (ok) return { ok, source };
  const message = expired ? `${deniedMessage(cap)} (el permiso caducó)` : deniedMessage(cap);
  return { ok, source, message };
}

// ─── Entorno limpio para lo que ejecuta el modelo ────────────────────────────

/** Lo que hereda un proceso lanzado por el modelo (shell_exec, consolas). Todo lo demás se borra. */
export const SAFE_PASS_ENV = [
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TZ", "TMPDIR",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP",
  "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "SSH_AUTH_SOCK", "EDITOR", "VISUAL", "TMUX", "TMUX_PANE",
  // Ubicaciones de ISyMCP (no secretos): las consolas responden al monitor correcto.
  "CODEX_WEB_HTTP_HOME", "CODEX_WEB_HTTP_MONITOR_DB", "ISYMCP_MONITOR_URL",
];

/** Credenciales: nunca pasan aunque alguien las pida (el bridge token sí sería la llave del puente). */
export const SECRET_ENV = /^CODEX_WEB_HTTP_(?!HOME$|MONITOR_DB$)|TOKEN|SECRET|PASSWORD|API_KEY|^OPENAI_|^ANTHROPIC_|COOKIE/i;

/** Copia de `base` solo con SAFE_PASS_ENV (+extra), sin nada que parezca credencial. */
export function scrubbedEnv(base: Record<string, string | undefined> = process.env, extra: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...SAFE_PASS_ENV, ...extra]) {
    const v = base[k];
    if (v !== undefined && !SECRET_ENV.test(k)) out[k] = v;
  }
  return out;
}
