// src/agents/catalog.ts — ÚNICA fuente de verdad de los agentes/TUIs que ISyMCP conoce.
//
// Antes había tres tablas que se desincronizaban (de ahí salieron bugs como openisy escribiendo en
// ~/.config/opencode): agent-tuis.ts (consolas), harness.ts (instalar MCP) y tui.ts (tui install).
// Ahora cada agente se declara UNA vez aquí y esos tres módulos son vistas derivadas:
//
//   console   cómo se arranca su consola y cómo le llegan las tareas (src/agent-tuis.ts)
//   mcp       cómo se le instala un servidor MCP (src/harness.ts)
//   tuiFormat cómo lo trata `isymcp tui install` (src/tui.ts)
//   config    dónde vive su config: una sola función de ruta para harness y tui
//
// Datos verificados con el --help / la config real de cada herramienta el 2026-11-11.
import { homedir } from "node:os";
import { join } from "node:path";
import { cli, crushStrategy, mcpServersStrategy, opencodeStrategy, type Strategy } from "./mcp-config";

export type ListenerStyle = "agy-task" | "background-bash" | "inject";
/**
 * Cómo lo trata `isymcp tui install`: "opencode" = además del MCP, el provider de modelos Web;
 * "harness" = solo el MCP, siempre por src/harness.ts (`--server gateway`).
 */
export type TuiFormat = "opencode" | "harness";
type Env = Record<string, string | undefined>;

export interface ConsoleProfile {
  /** Subcomando fijo antes del prompt (p. ej. `hermes chat`). */
  baseArgs?: string[];
  promptVia: "argv" | "inject";
  /** argv del prompt inicial (solo promptVia "argv"). */
  promptArgs?: (prompt: string, opts: { mode?: string; cliPath?: string }) => string[];
  listener: ListenerStyle;
  /** Espera antes de pegar el prompt inicial (promptVia "inject"). */
  injectDelayMs?: number;
}

export interface AgentConfigLocation {
  /** Variable que reemplaza el home para esta config (tests y entornos aislados). */
  homeEnv?: string;
  dir: (home: string, env: Env) => string;
  /** Archivo real de config; ausente = la herramienta la maneja con su propio `mcp add`. */
  file?: (home: string, env: Env) => string;
}

export interface AgentDef {
  id: string;
  label: string;
  aliases: string[];
  /** Ejecutables a buscar en PATH, en orden. */
  executables: string[];
  /** Rutas conocidas fuera del PATH. */
  extraPaths?: string[];
  config?: AgentConfigLocation;
  console?: ConsoleProfile;
  /** Instalación de MCP; recibe la ruta resuelta de `config.file`. null = sin estrategia verificada. */
  mcp: ((configPath: () => string) => Strategy) | null;
  /** Por qué no hay estrategia MCP (si mcp es null). */
  pending?: string;
  /** Presencia en `isymcp tui install`; ausente = no aparece ahí. */
  tuiFormat?: TuiFormat;
}

/** Regla de permisos de Claude Code: solo `bun run "<cli>" monitor ...` (prefijo exacto, con comillas). */
export function claudeMonitorRule(cliPath: string): string {
  return `Bash(bun run "${cliPath}" monitor:*)`;
}

const HOME = homedir();
const userScopeCli = cli({
  add: (exe, l, n) => [exe, "mcp", "add", "--scope", "user", n, l],
  remove: (exe, n) => [exe, "mcp", "remove", "--scope", "user", n],
  list: (exe) => [exe, "mcp", "list"],
});
const dashDashCli = cli({
  add: (exe, l, n) => [exe, "mcp", "add", n, "--", l],
  remove: (exe, n) => [exe, "mcp", "remove", n],
  list: (exe) => [exe, "mcp", "list"],
});
const injectConsole = (extra: Partial<ConsoleProfile> = {}): ConsoleProfile => ({ promptVia: "inject", listener: "inject", injectDelayMs: 6000, ...extra });

export const AGENTS: AgentDef[] = [
  {
    id: "claude", label: "Claude Code", aliases: ["claude-code", "claudecode"], executables: ["claude"],
    config: { dir: (h) => join(h, ".claude") },
    // inject y no background-bash: re-armar wait-next depende de que el modelo se acuerde en cada turno;
    // Claude Code acepta el texto pegado como mensaje nuevo (o lo encola si está ocupado). Verificado en vivo.
    // --allowedTools: solo los comandos de coordinación de ISyMCP quedan pre-aprobados; el prompt va ANTES
    // porque --allowedTools es variádico y se tragaría lo que venga después.
    console: {
      promptVia: "argv", listener: "inject",
      promptArgs: (p, o) => (o.cliPath ? [p, "--allowedTools", claudeMonitorRule(o.cliPath)] : [p]),
    },
    mcp: () => cli({
      // scope user: disponible en todos los proyectos (el default es "local").
      add: (exe, l, n) => [exe, "mcp", "add", "--scope", "user", n, "--", l],
      remove: (exe, n) => [exe, "mcp", "remove", "--scope", "user", n],
      list: (exe, n) => [exe, "mcp", "get", n],
    }),
    tuiFormat: "harness",
  },
  {
    id: "codex", label: "Codex CLI", aliases: [], executables: ["codex"],
    config: { dir: (h) => join(h, ".codex"), file: (h) => join(h, ".codex", "config.toml") },
    console: { promptVia: "argv", promptArgs: (p) => [p], listener: "inject" },
    mcp: () => dashDashCli,
    tuiFormat: "harness",
  },
  { id: "qwen", label: "Qwen Code", aliases: [], executables: ["qwen"], mcp: () => userScopeCli },
  {
    id: "gemini", label: "Gemini CLI", aliases: [], executables: ["gemini"],
    // El Gemini CLI (no agy) lee mcpServers de ~/.gemini/settings.json. Su `mcp add` usa scope project por defecto: se fuerza user.
    config: { dir: (h) => join(h, ".gemini"), file: (h) => join(h, ".gemini", "settings.json") },
    console: { promptVia: "argv", promptArgs: (p) => ["-i", p], listener: "inject" },
    mcp: () => userScopeCli,
    tuiFormat: "harness",
  },
  { id: "grok", label: "Grok", aliases: [], executables: ["grok"], mcp: () => userScopeCli },
  {
    id: "copilot", label: "Copilot CLI", aliases: [], executables: ["copilot"],
    config: { dir: (h) => join(h, ".copilot") },
    console: { promptVia: "argv", promptArgs: (p) => ["-i", p], listener: "inject" },
    mcp: () => dashDashCli,
    tuiFormat: "harness",
  },
  {
    id: "hermes", label: "Hermes", aliases: [], executables: ["hermes"],
    config: { dir: (h) => join(h, ".hermes") },
    console: injectConsole({ baseArgs: ["chat"] }),
    mcp: () => cli({
      add: (exe, l, n) => [exe, "mcp", "add", n, "--command", l],
      remove: (exe, n) => [exe, "mcp", "remove", n],
      list: (exe) => [exe, "mcp", "list"],
    }),
    tuiFormat: "harness",
  },
  {
    id: "openclaw", label: "OpenClaw", aliases: [], executables: ["openclaw"],
    config: { dir: (h) => join(h, ".openclaw") },
    console: injectConsole({ baseArgs: ["chat"] }),
    mcp: () => cli({
      add: (exe, l, n) => [exe, "mcp", "add", n, "--command", l, "--no-probe"],
      remove: (exe, n) => [exe, "mcp", "unset", n],
      list: (exe) => [exe, "mcp", "list"],
    }),
    tuiFormat: "harness",
  },
  { id: "pi", label: "Pi", aliases: [], executables: ["pi"], mcp: () => dashDashCli },
  {
    id: "droid", label: "Factory Droid", aliases: ["factory"], executables: ["droid"],
    config: { dir: (h) => join(h, ".factory") },
    console: { promptVia: "argv", promptArgs: (p) => [p], listener: "inject" },
    mcp: () => cli({
      add: (exe, l, n) => [exe, "mcp", "add", n, l],
      remove: (exe, n) => [exe, "mcp", "remove", n],
      list: (exe) => [exe, "mcp", "list"],
    }),
    tuiFormat: "harness",
  },
  {
    id: "cursor", label: "Cursor", aliases: [], executables: ["cursor-agent", "cursor"],
    config: { homeEnv: "CURSOR_HOME", dir: (h) => join(h, ".cursor"), file: (h) => join(h, ".cursor", "mcp.json") },
    mcp: (path) => mcpServersStrategy(path, (l) => ({ command: l })),
    tuiFormat: "harness",
  },
  {
    id: "opencode", label: "opencode", aliases: [], executables: ["opencode"], extraPaths: [join(HOME, ".opencode", "bin", "opencode")],
    config: { homeEnv: "OPENCODE_HOME", dir: (h) => join(h, ".config", "opencode"), file: (h) => join(h, ".config", "opencode", "opencode.json") },
    console: { promptVia: "argv", promptArgs: (p) => ["--prompt", p], listener: "inject" },
    mcp: (path) => opencodeStrategy(path),
    tuiFormat: "opencode",
  },
  {
    // bin/openisy de OpenISy-v2 exporta OPENCODE_CONFIG_DIR=~/.openisy/config: NO lee ~/.config/opencode.
    id: "openisy", label: "OpenISy", aliases: ["open-isy"], executables: ["openisy"], extraPaths: [join(HOME, ".opencode", "bin", "openisy")],
    config: {
      homeEnv: "OPENISY_HOME",
      dir: (h, env) => env.OPENISY_CONFIG_DIR?.trim() || join(h, ".openisy", "config"),
      file: (h, env) => join(env.OPENISY_CONFIG_DIR?.trim() || join(h, ".openisy", "config"), "opencode.json"),
    },
    console: { promptVia: "argv", promptArgs: (p) => ["--prompt", p], listener: "inject" },
    mcp: (path) => opencodeStrategy(path),
    tuiFormat: "opencode",
  },
  {
    // agy (Antigravity CLI) lee ~/.gemini/config/mcp_config.json; el Gemini CLI usa settings.json.
    id: "agy", label: "Antigravity (agy)", aliases: ["antigravity"], executables: ["agy"],
    extraPaths: [join(HOME, ".local", "bin", "agy"), "/usr/local/bin/agy", "/usr/bin/agy"],
    config: { homeEnv: "AGY_HOME", dir: (h) => join(h, ".gemini", "config"), file: (h) => join(h, ".gemini", "config", "mcp_config.json") },
    console: { promptVia: "argv", promptArgs: (p, o) => ["-i", p, "--mode", o.mode || "auto"], listener: "agy-task" },
    mcp: (path) => mcpServersStrategy(path, (l) => ({ command: l, args: [], disabled: false })),
    tuiFormat: "harness",
  },
  {
    id: "kimi", label: "Kimi Code", aliases: [], executables: ["kimi"], extraPaths: [join(HOME, ".kimi-code", "bin", "kimi")],
    config: { homeEnv: "KIMI_HOME", dir: (h) => join(h, ".kimi-code"), file: (h) => join(h, ".kimi-code", "mcp.json") },
    console: injectConsole(),
    mcp: (path) => mcpServersStrategy(path, (l) => ({ command: l, args: [] })),
    tuiFormat: "harness",
  },
  {
    id: "crush", label: "Crush", aliases: [], executables: ["crush"],
    config: { homeEnv: "CRUSH_HOME", dir: (h) => join(h, ".config", "crush"), file: (h) => join(h, ".config", "crush", "crush.json") },
    console: injectConsole(),
    mcp: (path) => crushStrategy(path),
    tuiFormat: "harness",
  },
  { id: "fx", label: "fx", aliases: [], executables: ["fx"], mcp: null, pending: "CLI sin subcomando mcp nativo" },
  {
    id: "claude-desktop", label: "Claude Desktop", aliases: ["desktop"], executables: [],
    config: { homeEnv: "CLAUDE_DESKTOP_HOME", dir: (h) => join(h, ".config", "Claude"), file: (h) => join(h, ".config", "Claude", "claude_desktop_config.json") },
    // Sin ejecutable en PATH: harness lo detecta por su carpeta de config.
    mcp: (path) => mcpServersStrategy(path, (l) => ({ command: l })),
    tuiFormat: "harness",
  },
];

/** Busca por id o alias (sin distinguir mayúsculas). */
export function findAgent(idOrAlias: string | undefined): AgentDef | null {
  const key = String(idOrAlias ?? "").trim().toLowerCase();
  return AGENTS.find((a) => a.id === key || a.aliases.includes(key)) ?? null;
}

/** Home efectivo para la config de un agente: su variable de entorno o el home del usuario. */
export function agentHome(def: AgentDef, env: Env = process.env): string {
  return (def.config?.homeEnv && env[def.config.homeEnv]?.trim()) || homedir();
}

/** Ruta del archivo de config del agente (null si lo maneja con su propio `mcp add`). */
export function agentConfigFile(def: AgentDef, env: Env = process.env, home = agentHome(def, env)): string | null {
  return def.config?.file ? def.config.file(home, env) : null;
}
