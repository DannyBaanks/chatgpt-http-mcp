// src/agent-tuis.ts — Consolas de agentes que ISyMCP puede lanzar (vista de src/agents/catalog.ts).
//
// Antes solo existía agy (Antigravity). El catálogo único describe, para cada TUI,
// cómo arrancarla con una instrucción inicial y cómo le llegan las tareas
// siguientes de ChatGPT, para que todas hagan lo que hacía agy:
//
//   listener "agy-task"        agy registra `monitor wait-next` como /task en
//                              background (run_command WaitMsBeforeAsync) y
//                              Antigravity la despierta sola.
//   listener "background-bash" la TUI corre `monitor wait-next` en background
//                              y la propia TUI la re-invoca al terminar
//                              (Claude Code: Bash run_in_background).
//   listener "inject"          la TUI no sabe esperar en background: ISyMCP
//                              escribe la tarea nueva en su terminal (tmux
//                              paste-buffer) cuando ChatGPT la envía con
//                              monitor.submit + console_id.
//
// promptVia "argv": la TUI acepta la instrucción inicial por argumento
// (verificado con `--help` el 2026-11-11). "inject": no tiene flag interactivo
// con prompt; ISyMCP la pega en la terminal cuando la TUI ya arrancó.
import { existsSync } from "node:fs";
import { AGENTS, claudeMonitorRule, type ListenerStyle } from "./agents/catalog";

export { claudeMonitorRule };
export type { ListenerStyle };

export interface AgentTuiDef {
  id: string;
  label: string;
  aliases: string[];
  /** Ejecutables a buscar (PATH y rutas conocidas), en orden. */
  executables: string[];
  extraPaths?: string[];
  /** Subcomando fijo antes del prompt (p. ej. `hermes chat`). */
  baseArgs?: string[];
  promptVia: "argv" | "inject";
  /** argv del prompt inicial (solo promptVia "argv"). */
  promptArgs?: (prompt: string, opts: { mode?: string; cliPath?: string }) => string[];
  listener: ListenerStyle;
  /** Espera antes de pegar el prompt inicial (promptVia "inject"). */
  injectDelayMs?: number;
}

/** Vista del catálogo único (src/agents/catalog.ts): los agentes que tienen consola. */
export const AGENT_TUIS: AgentTuiDef[] = AGENTS.filter((a) => a.console).map((a) => ({
  id: a.id,
  label: a.label,
  aliases: a.aliases,
  executables: a.executables,
  ...(a.extraPaths ? { extraPaths: a.extraPaths } : {}),
  ...a.console!,
}));

export function resolveAgentTui(id: string | undefined): AgentTuiDef | null {
  const key = String(id ?? "agy").trim().toLowerCase();
  return AGENT_TUIS.find((a) => a.id === key || a.aliases.includes(key)) ?? null;
}

/** Ruta del ejecutable del agente, o null si no está instalado. */
export function findAgentBinary(def: AgentTuiDef, pathEnv = process.env.PATH ?? ""): string | null {
  for (const exe of def.executables) {
    const found = Bun.which(exe, { PATH: pathEnv });
    if (found) return found;
  }
  for (const p of def.extraPaths ?? []) if (existsSync(p)) return p;
  return null;
}

/** argv completo del agente (sin terminal ni wrapper). */
export function agentArgv(def: AgentTuiDef, bin: string, prompt: string, opts: { mode?: string; cliPath?: string } = {}): string[] {
  const base = [bin, ...(def.baseArgs ?? [])];
  return def.promptVia === "argv" && def.promptArgs ? [...base, ...def.promptArgs(prompt, opts)] : base;
}

export function agentIds(): string[] {
  return AGENT_TUIS.map((a) => a.id);
}
