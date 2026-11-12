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
//      encender/apagar no requiere reiniciar el server ni el túnel.
//   3. Un OperatorGrant de un solo uso del Control Center (runWithOperatorAuthorization).
//
// Por qué: el modelo puede leer contenido externo (webs, repos, issues) con instrucciones escondidas.
// Lo que ejecuta código queda detrás de una decisión explícita del operador.
import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  updated_at?: string;
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
  if (readFile(env)[cap] === true) return "file";
  if (operatorAuth.getStore()?.authorized === true) return "operator_grant";
  return null;
}

export function permissionEnabled(cap: Capability, env: Record<string, string | undefined> = process.env): boolean {
  return permissionSource(cap, env) !== null;
}

export function setPermission(cap: Capability, on: boolean, env: Record<string, string | undefined> = process.env): PermissionsFile {
  const home = bridgeHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const next: PermissionsFile = { ...readFile(env), [cap]: on, updated_at: new Date().toISOString() };
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
