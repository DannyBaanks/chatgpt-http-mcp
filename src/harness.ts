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
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "./codex-sessions";
import { securePrivatePath } from "./platform/private-path";
import { AGENTS, agentConfigFile } from "./agents/catalog";
import type { Strategy } from "./agents/mcp-config";

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

// Estrategias (cli/json) en src/agents/mcp-config.ts; qué agente usa cuál, en src/agents/catalog.ts.
export type { CliStrategy, JsonStrategy, Strategy } from "./agents/mcp-config";

export interface HarnessDef {
  id: string;
  label: string;
  executables: string[];
  strategy: Strategy | null;
  /** Por que no hay estrategia (si strategy es null). */
  pending?: string;
}

/**
 * Vista del catálogo único para instalar MCP: todo agente con ejecutable o con estrategia MCP
 * (Claude Desktop no tiene ejecutable: se detecta por su carpeta de config).
 * La ruta de config se resuelve en cada llamada (las variables *_HOME pueden cambiar).
 */
export const CATALOG: HarnessDef[] = AGENTS.filter((a) => a.executables.length > 0 || a.mcp !== null).map((a) => ({
  id: a.id,
  label: a.label,
  executables: a.executables,
  strategy: a.mcp ? a.mcp(() => agentConfigFile(a) ?? "") : null,
  ...(a.pending ? { pending: a.pending } : {}),
}));
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
