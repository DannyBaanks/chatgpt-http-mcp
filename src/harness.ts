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

export const MCP_NAME = "isymcp-chatgpt";

interface CliStrategy {
  kind: "cli";
  add: (exe: string, launcher: string) => string[];
  remove: (exe: string) => string[];
  /** Comando cuya salida contiene MCP_NAME si esta instalado. */
  list: (exe: string) => string[];
}

export interface HarnessDef {
  id: string;
  label: string;
  executables: string[];
  strategy: CliStrategy | null;
  /** Por que no hay estrategia (si strategy es null). */
  pending?: string;
}

const cli = (s: Omit<CliStrategy, "kind">): CliStrategy => ({ kind: "cli", ...s });

export const CATALOG: HarnessDef[] = [
  { id: "claude", label: "Claude Code", executables: ["claude"], strategy: cli({
    // scope user: disponible en todos los proyectos (el default es "local").
    add: (exe, l) => [exe, "mcp", "add", "--scope", "user", MCP_NAME, "--", l],
    remove: (exe) => [exe, "mcp", "remove", "--scope", "user", MCP_NAME],
    list: (exe) => [exe, "mcp", "get", MCP_NAME],
  }) },
  { id: "codex", label: "Codex", executables: ["codex"], strategy: cli({
    add: (exe, l) => [exe, "mcp", "add", MCP_NAME, "--", l],
    remove: (exe) => [exe, "mcp", "remove", MCP_NAME],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "qwen", label: "Qwen Code", executables: ["qwen"], strategy: cli({
    add: (exe, l) => [exe, "mcp", "add", "--scope", "user", MCP_NAME, l],
    remove: (exe) => [exe, "mcp", "remove", "--scope", "user", MCP_NAME],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "gemini", label: "Gemini CLI", executables: ["gemini"], strategy: cli({
    // gemini usa scope "project" por defecto: se fuerza user.
    add: (exe, l) => [exe, "mcp", "add", "--scope", "user", MCP_NAME, l],
    remove: (exe) => [exe, "mcp", "remove", "--scope", "user", MCP_NAME],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "grok", label: "Grok", executables: ["grok"], strategy: cli({
    add: (exe, l) => [exe, "mcp", "add", "--scope", "user", MCP_NAME, l],
    remove: (exe) => [exe, "mcp", "remove", "--scope", "user", MCP_NAME],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "copilot", label: "Copilot CLI", executables: ["copilot"], strategy: cli({
    add: (exe, l) => [exe, "mcp", "add", MCP_NAME, "--", l],
    remove: (exe) => [exe, "mcp", "remove", MCP_NAME],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "hermes", label: "Hermes", executables: ["hermes"], strategy: cli({
    add: (exe, l) => [exe, "mcp", "add", MCP_NAME, "--command", l],
    remove: (exe) => [exe, "mcp", "remove", MCP_NAME],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "openclaw", label: "OpenClaw", executables: ["openclaw"], strategy: cli({
    add: (exe, l) => [exe, "mcp", "add", MCP_NAME, "--command", l, "--no-probe"],
    remove: (exe) => [exe, "mcp", "unset", MCP_NAME],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "pi", label: "Pi", executables: ["pi"], strategy: cli({
    add: (exe, l) => [exe, "mcp", "add", MCP_NAME, "--", l],
    remove: (exe) => [exe, "mcp", "remove", MCP_NAME],
    list: (exe) => [exe, "mcp", "list"],
  }) },
  { id: "opencode", label: "opencode", executables: ["opencode"], strategy: null, pending: "su `mcp add` es interactivo: falta la edicion verificada de opencode.json" },
  { id: "crush", label: "Crush", executables: ["crush"], strategy: null, pending: "sin subcomando mcp: falta la edicion verificada de crush.json" },
  { id: "cursor", label: "Cursor Agent", executables: ["cursor-agent", "cursor"], strategy: null, pending: "falta la edicion verificada de ~/.cursor/mcp.json" },
  { id: "kimi", label: "Kimi", executables: ["kimi"], strategy: null, pending: "CLI sin subcomando mcp nativo" },
  { id: "fx", label: "fx", executables: ["fx"], strategy: null, pending: "CLI sin subcomando mcp nativo" },
];

/** Ejecutable por PATH, resuelto y verificado (regular + ejecutable). */
export function resolveExecutable(name: string, path = process.env.PATH): string | null {
  const found = Bun.which(name, { PATH: path ?? "" });
  if (!found) return null;
  try {
    const real = realpathSync(found);
    const info = statSync(real);
    if (!info.isFile() || (info.mode & 0o111) === 0) return null;
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

async function isInstalled(def: HarnessDef, exe: string): Promise<boolean | null> {
  if (!def.strategy) return null;
  const r = await run(def.strategy.list(exe), 20_000);
  if (r.timedOut || r.code === null) return null;
  // `claude mcp get` sale !=0 si no existe; los demas listan por nombre.
  if (def.id === "claude") return r.code === 0 && r.out.includes(MCP_NAME);
  return r.out.includes(MCP_NAME);
}

export async function detect(ids?: string[]): Promise<HarnessStatus[]> {
  const defs = ids ? CATALOG.filter((d) => ids.includes(d.id)) : CATALOG;
  return Promise.all(defs.map(async (def) => {
    const exe = def.executables.map((e) => resolveExecutable(e)).find(Boolean) ?? null;
    return {
      id: def.id, label: def.label, present: exe !== null, executable: exe,
      supported: def.strategy !== null,
      installed: exe ? await isInstalled(def, exe) : null,
      ...(def.pending ? { pending: def.pending } : {}),
    };
  }));
}

/** Lanzador sin espacios en la ruta (los configs guardan el comando tal cual). */
export function launcherPath(): string {
  return join(bridgeHome(), "bin", "isymcp-chatgpt-mcp");
}

export function ensureLauncher(mainTs = join(import.meta.dir, "mcp", "chatgpt.ts")): string {
  const path = launcherPath();
  mkdirSync(join(bridgeHome(), "bin"), { recursive: true });
  const quoted = `'${mainTs.replace(/'/g, `'\\''`)}'`;
  writeFileSync(path, `#!/usr/bin/env bash\n# generado por chatgpt-http-mcp (src/harness.ts)\nexec bun run ${quoted} "$@"\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export type HarnessAction = "install" | "uninstall";

export interface PlanStep {
  id: string;
  label: string;
  /** El comando exacto que se correria (null = nada que hacer). */
  argv: string[] | null;
  reason: string;
}

export async function plan(action: HarnessAction, ids: string[]): Promise<PlanStep[]> {
  const statuses = await detect(ids);
  const unknown = ids.filter((id) => !CATALOG.some((d) => d.id === id));
  const steps: PlanStep[] = unknown.map((id) => ({ id, label: id, argv: null, reason: "harness desconocido" }));
  for (const s of statuses) {
    const def = CATALOG.find((d) => d.id === s.id)!;
    if (!s.present) { steps.push({ id: s.id, label: s.label, argv: null, reason: "no esta instalado en esta maquina" }); continue; }
    if (!def.strategy) { steps.push({ id: s.id, label: s.label, argv: null, reason: `aun no soportado: ${def.pending}` }); continue; }
    if (action === "install" && s.installed === true) { steps.push({ id: s.id, label: s.label, argv: null, reason: "ya tiene isymcp-chatgpt" }); continue; }
    if (action === "uninstall" && s.installed === false) { steps.push({ id: s.id, label: s.label, argv: null, reason: "no lo tiene instalado" }); continue; }
    const argv = action === "install" ? def.strategy.add(s.executable!, launcherPath()) : def.strategy.remove(s.executable!);
    steps.push({ id: s.id, label: s.label, argv, reason: action === "install" ? "instalar" : "quitar" });
  }
  return steps;
}

export interface ApplyResult {
  id: string;
  ran: boolean;
  ok: boolean;
  /** Estado leido DESPUES con la propia herramienta. */
  verified: boolean | null;
  detail: string;
}

/**
 * Ejecuta el plan. `approved` tiene que ser true literal: la aprobacion del
 * usuario es explicita (CLI --apply / boton confirmar del panel).
 */
export async function apply(action: HarnessAction, ids: string[], approved: boolean): Promise<ApplyResult[]> {
  if (approved !== true) throw new Error("se requiere aprobacion explicita del usuario");
  const steps = await plan(action, ids);
  if (action === "install" && steps.some((s) => s.argv)) ensureLauncher();
  const results: ApplyResult[] = [];
  for (const step of steps) {
    if (!step.argv) { results.push({ id: step.id, ran: false, ok: true, verified: null, detail: step.reason }); continue; }
    const r = await run(step.argv, 60_000);
    const def = CATALOG.find((d) => d.id === step.id)!;
    const exe = step.argv[0]!;
    const now = await isInstalled(def, exe);
    const verified = now === null ? null : action === "install" ? now === true : now === false;
    results.push({
      id: step.id, ran: true, ok: r.code === 0 && verified !== false, verified,
      detail: r.timedOut ? "timeout" : r.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300),
    });
  }
  return results;
}
