// src/agent-tuis.ts — Catálogo multiharness de consolas de agentes que ISyMCP puede lanzar.
//
// Antes solo existía agy (Antigravity). Este catálogo describe, para cada TUI,
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
import { homedir } from "node:os";
import { join } from "node:path";

export type ListenerStyle = "agy-task" | "background-bash" | "inject";

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
  promptArgs?: (prompt: string, opts: { mode?: string }) => string[];
  listener: ListenerStyle;
  /** Espera antes de pegar el prompt inicial (promptVia "inject"). */
  injectDelayMs?: number;
}

export const AGENT_TUIS: AgentTuiDef[] = [
  {
    id: "agy", label: "Antigravity (agy)", aliases: ["antigravity"],
    executables: ["agy"], extraPaths: [join(homedir(), ".local", "bin", "agy"), "/usr/local/bin/agy", "/usr/bin/agy"],
    promptVia: "argv", promptArgs: (p, o) => ["-i", p, "--mode", o.mode || "auto"], listener: "agy-task",
  },
  {
    id: "claude", label: "Claude Code", aliases: ["claude-code", "claudecode"],
    executables: ["claude"], promptVia: "argv", promptArgs: (p) => [p], listener: "background-bash",
  },
  {
    id: "opencode", label: "opencode", aliases: [],
    executables: ["opencode"], extraPaths: [join(homedir(), ".opencode", "bin", "opencode")],
    promptVia: "argv", promptArgs: (p) => ["--prompt", p], listener: "inject",
  },
  {
    id: "openisy", label: "OpenISy", aliases: ["open-isy"],
    executables: ["openisy"], extraPaths: [join(homedir(), ".opencode", "bin", "openisy")],
    promptVia: "argv", promptArgs: (p) => ["--prompt", p], listener: "inject",
  },
  {
    id: "codex", label: "Codex CLI", aliases: [],
    executables: ["codex"], promptVia: "argv", promptArgs: (p) => [p], listener: "inject",
  },
  {
    id: "gemini", label: "Gemini CLI", aliases: [],
    executables: ["gemini"], promptVia: "argv", promptArgs: (p) => ["-i", p], listener: "inject",
  },
  {
    id: "copilot", label: "Copilot CLI", aliases: [],
    executables: ["copilot"], promptVia: "argv", promptArgs: (p) => ["-i", p], listener: "inject",
  },
  {
    id: "droid", label: "Factory Droid", aliases: ["factory"],
    executables: ["droid"], promptVia: "argv", promptArgs: (p) => [p], listener: "inject",
  },
  {
    id: "kimi", label: "Kimi Code", aliases: [],
    executables: ["kimi"], extraPaths: [join(homedir(), ".kimi-code", "bin", "kimi")],
    promptVia: "inject", listener: "inject", injectDelayMs: 6000,
  },
  {
    id: "crush", label: "Crush", aliases: [],
    executables: ["crush"], promptVia: "inject", listener: "inject", injectDelayMs: 6000,
  },
  {
    id: "hermes", label: "Hermes", aliases: [],
    executables: ["hermes"], baseArgs: ["chat"], promptVia: "inject", listener: "inject", injectDelayMs: 6000,
  },
  {
    id: "openclaw", label: "OpenClaw", aliases: [],
    executables: ["openclaw"], baseArgs: ["chat"], promptVia: "inject", listener: "inject", injectDelayMs: 6000,
  },
];

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
export function agentArgv(def: AgentTuiDef, bin: string, prompt: string, opts: { mode?: string } = {}): string[] {
  const base = [bin, ...(def.baseArgs ?? [])];
  return def.promptVia === "argv" && def.promptArgs ? [...base, ...def.promptArgs(prompt, opts)] : base;
}

export function agentIds(): string[] {
  return AGENT_TUIS.map((a) => a.id);
}
