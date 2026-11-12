// harness.ts — motor que detecta las CLIs/TUIs de agentes instaladas y les
// instala (o quita) el MCP "isymcp-chatgpt", siempre con aprobacion.
//
// Catalogo e higiene de deteccion portados de ISyCode (harness_probe.py):
// ejecutable resuelto por PATH, archivo regular y ejecutable, nada de shell.
//
// Estrategias:
//   cli  — la herramienta trae su propio `mcp add/remove`: ELLA escribe su
//          formato (lo mas seguro). Verificado a mano 2026-10-07 contra
//          `--help` de claude, codex, qwen, gemini y grok.
//   null — detectado, pero sin estrategia verificada: no se adivina formato.
//
// Flujo: detect -> plan (comando exacto, nada se escribe) -> apply (solo con
// aprobacion explicita) -> verify (la propia herramienta lista el servidor).
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bridgeHome } from "./codex-sessions";
import { securePrivatePath } from "./platform/private-path";

export const MCP_NAME = "isymcp-chatgpt";
/** Gateway universal ISyMCP (src/mcp/main.ts --contract native): tool `isymcp`, monitor, consolas, media... */
export const GATEWAY_MCP_NAME = "isymcp";
/** Nombres con los que el gateway ya puede estar instalado (tui.ts lo llamaba isyco-web-http en opencode). */
export const GATEWAY_ALIASES = [GATEWAY_MCP_NAME, "isyco-web-http"];

/** Qué servidor MCP se instala: el de chatgpt_ask o el gateway completo. */
export type McpServerKind = "chatgpt" | "gateway";

export function serverName(kind: McpServerKind = "chatgpt"): string {
  return kind === "gateway" ? GATEWAY_MCP_NAME : MCP_NAME;
}
function serverNames(kind: McpServerKind): string[] {
  return kind === "gateway" ? GATEWAY_ALIASES : [MCP_NAME];
}

/** `out` nombra el servidor como palabra completa (isymcp no casa con isymcp-chatgpt). */
export function mentionsServer(out: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${esc}([^\\w-]|$)`, "m").test(out);
}

interface CliStrategy {
  kind: "cli";
  add: (exe: string, launcher: string, name: string) => string[];
  remove: (exe: string, name: string) => string[];
  /** Comando cuya salida contiene el nombre si esta instalado. */
  list: (exe: string, name: string) => string[];
}

export interface JsonStrategy {
  kind: "json";
  configPath: () => string;
  readInstalled: (path: string, names: string[]) => boolean;
  add: (path: string, launcher: string, name: string) => void;
  remove: (path: string, names: string[]) => void;
}

export type Strategy = CliStrategy | JsonStrategy;

export interface HarnessDef {
  id: string;
  label: string;
  executables: string[];
  strategy: Strategy | null;
  /** Por que no hay estrategia (si strategy es null). */
  pending?: string;
}

const cli = (s: Omit<CliStrategy, "kind">): CliStrategy => ({ kind: "cli", ...s });

function homeFrom(envVar: string): string {
  return process.env[envVar]?.trim() || homedir();
}
function cursorConfigPath(): string {
  return join(homeFrom("CURSOR_HOME"), ".cursor", "mcp.json");
}
function opencodeConfigPath(): string {
  return join(homeFrom("OPENCODE_HOME"), ".config", "opencode", "opencode.json");
}
/** openisy corre con OPENCODE_CONFIG_DIR=~/.openisy/config (bin/openisy de OpenISy-v2), no con ~/.config/opencode. */
function openisyConfigPath(): string {
  const dir = process.env.OPENISY_CONFIG_DIR?.trim() || join(homeFrom("OPENISY_HOME"), ".openisy", "config");
  return join(dir, "opencode.json");
}
/** agy (Antigravity CLI) lee ~/.gemini/config/mcp_config.json; el Gemini CLI usa otro archivo (settings.json). */
function agyConfigPath(): string {
  return join(homeFrom("AGY_HOME"), ".gemini", "config", "mcp_config.json");
}
function kimiConfigPath(): string {
  return join(homeFrom("KIMI_HOME"), ".kimi-code", "mcp.json");
}
function crushConfigPath(): string {
  return join(homeFrom("CRUSH_HOME"), ".config", "crush", "crush.json");
}

function readJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}
/** Escribe solo si el archivo existente se pudo leer: nunca se pisa un JSON que no se entendió. */
function editJson(path: string, edit: (data: Record<string, any>) => boolean): void {
  let data: Record<string, any> = {};
  if (existsSync(path)) {
    const parsed = readJson(path);
    if (!parsed) throw new Error(`no se pudo leer ${path} como JSON: no se modifica`);
    data = parsed;
  } else {
    mkdirSync(join(path, ".."), { recursive: true });
  }
  if (edit(data)) writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/** Formato `mcpServers` (Cursor, agy, Kimi Code). */
function mcpServersStrategy(configPath: () => string, entry: (launcher: string) => Record<string, unknown>): JsonStrategy {
  return {
    kind: "json",
    configPath,
    readInstalled: (path, names) => {
      const data = readJson(path);
      return names.some((n) => Boolean(data?.mcpServers?.[n]));
    },
    add: (path, launcher, name) => editJson(path, (data) => {
      data.mcpServers = data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {};
      data.mcpServers[name] = entry(launcher);
      return true;
    }),
    remove: (path, names) => {
      if (!existsSync(path)) return;
      editJson(path, (data) => {
        const hits = names.filter((n) => data?.mcpServers?.[n]);
        for (const n of hits) delete data.mcpServers[n];
        return hits.length > 0;
      });
    },
  };
}

/**
 * Formato opencode (también openisy). Se escribe la forma `mcp.<nombre>`: v2 la normaliza
 * (verificado 2026-11-11: el servicio de opencode 2.2.5 y el de openisy lanzan el servidor).
 * Se lee también la forma nativa v2 `mcp.servers.<nombre>`.
 */
function opencodeStrategy(configPath: () => string): JsonStrategy {
  return {
    kind: "json",
    configPath,
    readInstalled: (path, names) => {
      const data = readJson(path);
      return names.some((n) => Boolean(data?.mcp?.[n] || data?.mcp?.servers?.[n]));
    },
    add: (path, launcher, name) => editJson(path, (data) => {
      data.mcp = data.mcp && typeof data.mcp === "object" ? data.mcp : {};
      data.mcp[name] = { type: "local", command: [launcher], enabled: true };
      return true;
    }),
    remove: (path, names) => {
      if (!existsSync(path)) return;
      editJson(path, (data) => {
        let changed = false;
        for (const n of names) {
          if (data?.mcp?.[n]) { delete data.mcp[n]; changed = true; }
          if (data?.mcp?.servers?.[n]) { delete data.mcp.servers[n]; changed = true; }
        }
        return changed;
      });
    },
  };
}

/** Crush: `mcp.<nombre> = { type: "stdio", command }` en ~/.config/crush/crush.json. */
const crushStrategy: JsonStrategy = {
  kind: "json",
  configPath: crushConfigPath,
  readInstalled: (path, names) => {
    const data = readJson(path);
    return names.some((n) => Boolean(data?.mcp?.[n]));
  },
  add: (path, launcher, name) => editJson(path, (data) => {
    data.mcp = data.mcp && typeof data.mcp === "object" ? data.mcp : {};
    data.mcp[name] = { type: "stdio", command: launcher };
    return true;
  }),
  remove: (path, names) => {
    if (!existsSync(path)) return;
    editJson(path, (data) => {
      const hits = names.filter((n) => data?.mcp?.[n]);
      for (const n of hits) delete data.mcp[n];
      return hits.length > 0;
    });
  },
};

const cursorStrategy = mcpServersStrategy(cursorConfigPath, (l) => ({ command: l }));

export const CATALOG: HarnessDef[] = [
  { id: "claude", label: "Claude Code", executables: ["claude"], strategy: cli({
    // scope user: disponible en todos los proyectos (el default es "local").
    add: (exe, l, n) => [exe, "mcp", "add", "--scope", "user", n, "--", l],
    remove: (exe, n) => [exe, "mcp", "remove", "--scope", "user", n],
    list: (exe, n) => [exe, "mcp", "get", n],
  }) },
  { id: "codex", label: "Codex", executables: ["codex"], strategy: cli({
    add: (exe, l, n) => [exe, "mcp", "add", n, "--", l],
    remove: (exe, n) => [exe, "mcp", "remove", n],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "qwen", label: "Qwen Code", executables: ["qwen"], strategy: cli({
    add: (exe, l, n) => [exe, "mcp", "add", "--scope", "user", n, l],
    remove: (exe, n) => [exe, "mcp", "remove", "--scope", "user", n],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "gemini", label: "Gemini CLI", executables: ["gemini"], strategy: cli({
    // gemini usa scope "project" por defecto: se fuerza user.
    add: (exe, l, n) => [exe, "mcp", "add", "--scope", "user", n, l],
    remove: (exe, n) => [exe, "mcp", "remove", "--scope", "user", n],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "grok", label: "Grok", executables: ["grok"], strategy: cli({
    add: (exe, l, n) => [exe, "mcp", "add", "--scope", "user", n, l],
    remove: (exe, n) => [exe, "mcp", "remove", "--scope", "user", n],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "copilot", label: "Copilot CLI", executables: ["copilot"], strategy: cli({
    add: (exe, l, n) => [exe, "mcp", "add", n, "--", l],
    remove: (exe, n) => [exe, "mcp", "remove", n],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "hermes", label: "Hermes", executables: ["hermes"], strategy: cli({
    add: (exe, l, n) => [exe, "mcp", "add", n, "--command", l],
    remove: (exe, n) => [exe, "mcp", "remove", n],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "openclaw", label: "OpenClaw", executables: ["openclaw"], strategy: cli({
    add: (exe, l, n) => [exe, "mcp", "add", n, "--command", l, "--no-probe"],
    remove: (exe, n) => [exe, "mcp", "unset", n],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "pi", label: "Pi", executables: ["pi"], strategy: cli({
    add: (exe, l, n) => [exe, "mcp", "add", n, "--", l],
    remove: (exe, n) => [exe, "mcp", "remove", n],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "droid", label: "Factory Droid", executables: ["droid"], strategy: cli({
    add: (exe, l, n) => [exe, "mcp", "add", n, l],
    remove: (exe, n) => [exe, "mcp", "remove", n],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "cursor", label: "Cursor Agent", executables: ["cursor-agent", "cursor"], strategy: cursorStrategy },
  { id: "opencode", label: "opencode", executables: ["opencode"], strategy: opencodeStrategy(opencodeConfigPath) },
  { id: "openisy", label: "OpenISy", executables: ["openisy"], strategy: opencodeStrategy(openisyConfigPath) },
  { id: "agy", label: "Antigravity (agy)", executables: ["agy"], strategy: mcpServersStrategy(agyConfigPath, (l) => ({ command: l, args: [], disabled: false })) },
  { id: "kimi", label: "Kimi Code", executables: ["kimi"], strategy: mcpServersStrategy(kimiConfigPath, (l) => ({ command: l, args: [] })) },
  { id: "crush", label: "Crush", executables: ["crush"], strategy: crushStrategy },
  { id: "fx", label: "fx", executables: ["fx"], strategy: null, pending: "CLI sin subcomando mcp nativo" },
];

/** Ejecutable por PATH, resuelto y verificado (regular + ejecutable). */
export function resolveExecutable(name: string, path = process.env.PATH): string | null {
  const found = Bun.which(name, { PATH: path ?? "" });
  if (!found) return null;
  try {
    const real = realpathSync(found);
    const info = statSync(real);
    // PATHEXT ya decide que esto es ejecutable en Windows (.exe/.cmd/.bat) y el
    // modo que reporta Bun nunca trae bit de ejecucion: el check POSIX alli no aplica.
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o111) === 0)) return null;
    return found;
  } catch {
    return null;
  }
}

/** Ejecuta argv SIN shell, stdin cerrado, con timeout; nunca lanza. */
export async function run(argv: string[], timeoutMs: number): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(9); }, timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { code: timedOut ? null : code, out: `${out}${err}`.slice(-4000), timedOut };
  } catch (error) {
    return { code: null, out: String(error).slice(0, 400), timedOut: false };
  }
}

export interface HarnessStatus {
  id: string;
  label: string;
  present: boolean;
  executable: string | null;
  supported: boolean;
  /** null si no se pudo determinar (sin estrategia o la consulta fallo). */
  installed: boolean | null;
  pending?: string;
}

/** El CLI no tiene subcomando mcp (p. ej. un `pi` que no es el agente Pi). */
const NO_MCP_SUBCOMMAND = /invalid choice: 'mcp'|unknown command '?mcp|unrecognized (sub)?command/i;

async function isInstalled(def: HarnessDef, exe: string | null, kind: McpServerKind = "chatgpt"): Promise<boolean | null> {
  if (!def.strategy) return null;
  const names = serverNames(kind);
  if (def.strategy.kind === "cli") {
    if (!exe) return null;
    const r = await run(def.strategy.list(exe, serverName(kind)), 20_000);
    if (r.timedOut || r.code === null || NO_MCP_SUBCOMMAND.test(r.out)) return null;
    // `claude mcp get` sale !=0 si no existe; los demas listan por nombre.
    if (def.id === "claude") return r.code === 0 && mentionsServer(r.out, serverName(kind));
    return names.some((n) => mentionsServer(r.out, n));
  }
  if (def.strategy.kind === "json") {
    const path = def.strategy.configPath();
    if (!existsSync(path)) return false;
    try {
      return def.strategy.readInstalled(path, names);
    } catch {
      return null;
    }
  }
  return null;
}

export async function detect(ids?: string[], kind: McpServerKind = "chatgpt"): Promise<HarnessStatus[]> {
  const defs = ids ? CATALOG.filter((d) => ids.includes(d.id)) : CATALOG;
  return Promise.all(defs.map(async (def) => {
    const exe = def.executables.map((e) => resolveExecutable(e)).find(Boolean) ?? null;
    const present = exe !== null || (def.strategy?.kind === "json" && existsSync(join(def.strategy.configPath(), "..")));
    return {
      id: def.id, label: def.label, present, executable: exe,
      supported: def.strategy !== null,
      installed: present ? await isInstalled(def, exe, kind) : null,
      ...(def.pending ? { pending: def.pending } : {}),
    };
  }));
}

/** Lanzador sin espacios en la ruta (los configs guardan el comando tal cual). */
export function launcherPath(): string {
  return join(bridgeHome(), "bin", process.platform === "win32" ? "isymcp-chatgpt-mcp.cmd" : "isymcp-chatgpt-mcp");
}

export function ensureLauncher(mainTs = join(import.meta.dir, "mcp", "chatgpt.ts")): string {
  const path = launcherPath();
  const binDir = join(bridgeHome(), "bin");
  mkdirSync(binDir, { recursive: true });
  securePrivatePath(binDir, true);
  if (process.platform === "win32") {
    writeFileSync(path, `@echo off\r\n"${process.execPath}" run "${mainTs}" %*\r\n`);
    securePrivatePath(path, false);
    return path;
  }
  const quoted = `'${mainTs.replace(/'/g, `'\\''`)}'`;
  writeFileSync(path, `#!/usr/bin/env bash\n# generado por chatgpt-http-mcp (src/harness.ts)\nexec bun run ${quoted} "$@"\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export function gatewayLauncherPath(): string {
  return join(bridgeHome(), "bin", process.platform === "win32" ? "isymcp-gateway-mcp.cmd" : "isymcp-gateway-mcp");
}

/** Lanzador del gateway (main.ts --contract native) sin espacios ni argumentos: un solo comando para cualquier config. */
export function ensureGatewayLauncher(mainTs = join(import.meta.dir, "mcp", "main.ts")): string {
  const path = gatewayLauncherPath();
  const binDir = join(bridgeHome(), "bin");
  mkdirSync(binDir, { recursive: true });
  securePrivatePath(binDir, true);
  if (process.platform === "win32") {
    writeFileSync(path, `@echo off\r\n"${process.execPath}" run "${mainTs}" --contract native %*\r\n`);
    securePrivatePath(path, false);
    return path;
  }
  const quoted = `'${mainTs.replace(/'/g, `'\\''`)}'`;
  writeFileSync(path, `#!/usr/bin/env bash\n# generado por chatgpt-http-mcp (src/harness.ts): gateway ISyMCP\nexec bun run ${quoted} --contract native "$@"\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function launcherFor(kind: McpServerKind): string {
  return kind === "gateway" ? gatewayLauncherPath() : launcherPath();
}

export type HarnessAction = "install" | "uninstall";

export interface PlanStep {
  id: string;
  label: string;
  /** El comando exacto que se correria (null = nada que hacer o accion JSON). */
  argv: string[] | null;
  reason: string;
}

export async function plan(action: HarnessAction, ids: string[], kind: McpServerKind = "chatgpt"): Promise<PlanStep[]> {
  const statuses = await detect(ids, kind);
  const name = serverName(kind);
  const unknown = ids.filter((id) => !CATALOG.some((d) => d.id === id));
  const steps: PlanStep[] = unknown.map((id) => ({ id, label: id, argv: null, reason: "harness desconocido" }));
  for (const s of statuses) {
    const def = CATALOG.find((d) => d.id === s.id)!;
    if (!s.present) { steps.push({ id: s.id, label: s.label, argv: null, reason: "no esta instalado en esta maquina" }); continue; }
    if (!def.strategy) { steps.push({ id: s.id, label: s.label, argv: null, reason: `aun no soportado: ${def.pending}` }); continue; }
    if (def.strategy.kind === "cli" && s.installed === null) { steps.push({ id: s.id, label: s.label, argv: null, reason: "aun no soportado: este ejecutable no responde a `mcp list`" }); continue; }
    if (action === "install" && s.installed === true) { steps.push({ id: s.id, label: s.label, argv: null, reason: `ya tiene ${name}` }); continue; }
    if (action === "uninstall" && s.installed === false) { steps.push({ id: s.id, label: s.label, argv: null, reason: "no lo tiene instalado" }); continue; }
    if (def.strategy.kind === "cli") {
      const argv = action === "install" ? def.strategy.add(s.executable!, launcherFor(kind), name) : def.strategy.remove(s.executable!, name);
      steps.push({ id: s.id, label: s.label, argv, reason: action === "install" ? "instalar" : "quitar" });
    } else {
      const cfg = def.strategy.configPath();
      steps.push({ id: s.id, label: s.label, argv: null, reason: action === "install" ? `configurar en ${cfg}` : `quitar de ${cfg}` });
    }
  }
  return steps;
}

export interface ApplyResult {
  id: string;
  ran: boolean;
  ok: boolean;
  /** Estado leido DESPUES con la propia herramienta o archivo. */
  verified: boolean | null;
  detail: string;
}

/**
 * Ejecuta el plan. `approved` tiene que ser true literal: la aprobacion del
 * usuario es explicita (CLI --apply / boton confirmar del panel).
 */
export async function apply(action: HarnessAction, ids: string[], approved: boolean, kind: McpServerKind = "chatgpt"): Promise<ApplyResult[]> {
  if (approved !== true) throw new Error("se requiere aprobacion explicita del usuario");
  const steps = await plan(action, ids, kind);
  if (action === "install" && steps.some((s) => s.reason.startsWith("instalar") || s.reason.startsWith("configurar") || s.argv)) {
    if (kind === "gateway") ensureGatewayLauncher(); else ensureLauncher();
  }
  const results: ApplyResult[] = [];
  for (const step of steps) {
    const def = CATALOG.find((d) => d.id === step.id);
    if (!def || !def.strategy) {
      results.push({ id: step.id, ran: false, ok: true, verified: null, detail: step.reason });
      continue;
    }
    if (step.reason.startsWith("ya tiene") || step.reason.startsWith("no lo tiene") || step.reason.startsWith("no esta instalado") ||
      step.reason.startsWith("aun no soportado") || step.reason.startsWith("harness desconocido")) {
      results.push({ id: step.id, ran: false, ok: true, verified: null, detail: step.reason });
      continue;
    }
    if (def.strategy.kind === "json") {
      const cfg = def.strategy.configPath();
      try {
        if (action === "install") def.strategy.add(cfg, launcherFor(kind), serverName(kind));
        else def.strategy.remove(cfg, serverNames(kind));
      } catch (error) {
        results.push({ id: step.id, ran: false, ok: false, verified: false, detail: String((error as Error).message ?? error).slice(0, 300) });
        continue;
      }
      const verified = def.strategy.readInstalled(cfg, serverNames(kind)) === (action === "install");
      results.push({
        id: step.id,
        ran: true,
        ok: verified,
        verified,
        detail: `${action === "install" ? "configurado" : "eliminado"} en ${cfg}`,
      });
      continue;
    }
    if (step.argv) {
      const r = await run(step.argv, 60_000);
      const exe = step.argv[0]!;
      const now = await isInstalled(def, exe, kind);
      const verified = now === null ? null : action === "install" ? now === true : now === false;
      results.push({
        id: step.id, ran: true, ok: r.code === 0 && verified !== false, verified,
        detail: r.timedOut ? "timeout" : r.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300),
      });
    }
  }
  return results;
}
