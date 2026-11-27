// src/hub/config.ts — Configuración del hub de MCP (`isymcp hub`).
//
// El hub es un daemon ajeno a las TUIs: arranca una vez los MCP de la máquina y cada TUI se
// engancha a él con un solo MCP (`isymcp hub connect`). Este archivo define qué MCP hay detrás.
//
// Archivo: <bridge home>/hub/servers.json (por defecto ~/.codex-web-http/hub/servers.json):
//   { "servers": { "rea": { "command": "...", "args": ["mcp"], "env": {...},
//                           "isolation": "per-client", "prewarm": 1 } } }
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hubConfigPath } from "./paths";

export { hubConfigPath, hubHome } from "./paths";

export type Isolation = "shared" | "per-client";

export interface HubServerConfig {
  /** Ejecutable del MCP por stdio. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * shared: un proceso para todas las TUIs (el SDK multiplexa las peticiones).
   * per-client: un proceso por TUI conectada, para MCP con estado de sesión (REA guarda el binario
   * abierto) o que solo admiten un cliente.
   */
  isolation?: Isolation;
  /** per-client: procesos calientes de reserva, listos antes de que conecte una TUI. */
  prewarm?: number;
  /** per-client: tope de procesos vivos (reservas incluidas). */
  max_instances?: number;
  /** Plazo para initialize + tools/list de un proceso nuevo. */
  startup_timeout_ms?: number;
  /** Plazo total de una llamada a tool. */
  call_timeout_ms?: number;
  /** Plazo de inactividad tras el cual un proceso MCP hiberna a 0 RAM (0 = nunca hibernar). */
  idle_timeout_ms?: number;
  /** false = declarado pero sin arrancar. */
  enabled?: boolean;
  /** Texto corto para el listado de hub_discover. */
  description?: string;
  /**
   * hub (por defecto): lo arranca el daemon y se usa por hub_execute.
   * direct: el daemon no lo arranca; cada TUI lo registra como su propio MCP, tal cual
   * (`isymcp-hub connect --direct <nombre>`), y se lanza con el entorno de la TUI. Para MCP con
   * tokens o datos de sesión de la TUI (mxterm, node_repl de Codex, office-bridge).
   */
  mode?: "hub" | "direct";
}

export interface HubConfig {
  /** Opt-in: si es true, `isymcp-hub connect` reconecta solo tras reiniciar el daemon sin cortar la TUI. */
  auto_reconnect?: boolean;
  servers: Record<string, HubServerConfig>;
}

export const DEFAULTS = {
  prewarm: 1,
  max_instances: 4,
  startup_timeout_ms: 120_000,
  call_timeout_ms: 30 * 60_000,
  idle_timeout_ms: 10 * 60_000,
} as const;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Valida y normaliza; lanza Error con el campo culpable para que el operador lo corrija. */
export function parseHubConfig(raw: unknown): HubConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("hub_config_invalid: se esperaba un objeto");
  const autoReconnect = (raw as { auto_reconnect?: unknown }).auto_reconnect;
  if (autoReconnect !== undefined && typeof autoReconnect !== "boolean") throw Error("hub_config_invalid: auto_reconnect debe ser booleano");
  const servers = (raw as { servers?: unknown }).servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw Error("hub_config_invalid: falta 'servers'");
  const out: Record<string, HubServerConfig> = {};
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!NAME_RE.test(name)) throw Error(`hub_config_invalid: nombre de servidor no válido '${name}'`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`hub_config_invalid: servers.${name} debe ser un objeto`);
    const v = value as Record<string, unknown>;
    if (typeof v.command !== "string" || !v.command.trim()) throw Error(`hub_config_invalid: servers.${name}.command`);
    if (v.args !== undefined && !(Array.isArray(v.args) && v.args.every((a) => typeof a === "string"))) throw Error(`hub_config_invalid: servers.${name}.args`);
    if (v.env !== undefined && !(v.env && typeof v.env === "object" && !Array.isArray(v.env) && Object.values(v.env).every((e) => typeof e === "string"))) throw Error(`hub_config_invalid: servers.${name}.env`);
    if (v.isolation !== undefined && v.isolation !== "shared" && v.isolation !== "per-client") throw Error(`hub_config_invalid: servers.${name}.isolation`);
    for (const k of ["prewarm", "max_instances", "startup_timeout_ms", "call_timeout_ms", "idle_timeout_ms"] as const) {
      if (v[k] !== undefined && !(Number.isInteger(v[k]) && (v[k] as number) >= 0)) throw Error(`hub_config_invalid: servers.${name}.${k}`);
    }
    if (v.max_instances === 0) throw Error(`hub_config_invalid: servers.${name}.max_instances debe ser >= 1`);
    if (v.mode !== undefined && v.mode !== "hub" && v.mode !== "direct") throw Error(`hub_config_invalid: servers.${name}.mode`);
    out[name] = {
      command: v.command,
      args: v.args as string[] | undefined,
      env: v.env as Record<string, string> | undefined,
      cwd: typeof v.cwd === "string" ? v.cwd : undefined,
      isolation: (v.isolation as Isolation | undefined) ?? "shared",
      prewarm: v.prewarm as number | undefined,
      max_instances: v.max_instances as number | undefined,
      startup_timeout_ms: v.startup_timeout_ms as number | undefined,
      call_timeout_ms: v.call_timeout_ms as number | undefined,
      idle_timeout_ms: v.idle_timeout_ms as number | undefined,
      enabled: v.enabled === undefined ? true : v.enabled === true,
      description: typeof v.description === "string" ? v.description : undefined,
      ...(v.mode === "direct" ? { mode: "direct" as const } : {}),
    };
  }
  return { ...(typeof autoReconnect === "boolean" ? { auto_reconnect: autoReconnect } : {}), servers: out };
}

export function loadHubConfig(path = hubConfigPath()): HubConfig {
  if (!existsSync(path)) return { servers: {} };
  return parseHubConfig(JSON.parse(readFileSync(path, "utf8")));
}

/** Escritura atómica con permisos 0600 (la config puede llevar tokens en env). */
export function saveHubConfig(config: HubConfig, path = hubConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Servidores que el hub no debe importar: él mismo y su propio conector. */
export function isHubEntry(name: string, command: string, args: string[] = []): boolean {
  return name === "isymcp-hub" || /isymcp-hub$/.test(command) || (/isymcp(\.ts)?$/.test(command) && args.includes("hub"));
}

export interface ImportResult {
  added: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Importa los MCP por stdio de una config de cliente con forma `mcpServers` (Claude Code,
 * Cursor, Gemini, Qwen). No sobrescribe servidores que ya existan en el hub.
 */
export function importMcpServers(config: HubConfig, mcpServers: Record<string, unknown>, perClient: Set<string>): ImportResult {
  const res: ImportResult = { added: [], skipped: [] };
  for (const [name, value] of Object.entries(mcpServers)) {
    const v = (value ?? {}) as Record<string, unknown>;
    if (config.servers[name]) { res.skipped.push({ name, reason: "ya existe en el hub" }); continue; }
    if (typeof v.command !== "string") { res.skipped.push({ name, reason: v.url ? "remoto (url): aún no soportado" : "sin command" }); continue; }
    const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === "string") : [];
    if (isHubEntry(name, v.command, args)) { res.skipped.push({ name, reason: "es el propio hub" }); continue; }
    if (!NAME_RE.test(name)) { res.skipped.push({ name, reason: "nombre no válido" }); continue; }
    const env = v.env && typeof v.env === "object" ? Object.fromEntries(Object.entries(v.env as Record<string, unknown>).filter(([, e]) => typeof e === "string")) as Record<string, string> : undefined;
    config.servers[name] = {
      command: v.command,
      ...(args.length ? { args } : {}),
      ...(env && Object.keys(env).length ? { env } : {}),
      isolation: perClient.has(name) ? "per-client" : "shared",
      ...(perClient.has(name) ? { prewarm: DEFAULTS.prewarm } : {}),
    };
    res.added.push(name);
  }
  return res;
}
