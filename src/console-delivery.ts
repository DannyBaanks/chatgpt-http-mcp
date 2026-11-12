// src/console-delivery.ts — Entrega de tareas a consolas que no saben esperar en background.
//
// Las TUIs con listener "inject" (src/agent-tuis.ts) corren en un socket tmux
// dedicado. Cuando ChatGPT manda una tarea con monitor.submit + console_id,
// ISyMCP la pega en esa terminal con bracketed paste (paste-buffer -p: el texto
// multilínea entra como UN mensaje, no como varios Enter) y luego envía Enter.
// Sin shell: argv directo a tmux; el texto viaja por stdin.
import { resolveAgentTui } from "./agent-tuis";
import type { ConsoleRecord } from "./console-registry";

/** Socket tmux dedicado (-L) de las consolas multiharness; se lee en cada llamada (ISYMCP_CONSOLE_TMUX_SOCKET lo cambia). */
export function consoleTmuxSocket(): string {
  return process.env.ISYMCP_CONSOLE_TMUX_SOCKET?.trim() || "isymcp-consoles";
}

export interface DeliveryResult {
  delivered: boolean;
  reason: string;
}

type Runner = (argv: string[], stdin?: string) => { code: number; err: string };

const defaultRunner: Runner = (argv, stdin) => {
  const r = Bun.spawnSync(argv, { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "ignore", stderr: "pipe" });
  return { code: r.exitCode ?? 1, err: r.stderr ? new TextDecoder().decode(r.stderr).slice(0, 300) : "" };
};

/** Pega `text` en la sesión tmux de la consola y lo envía. */
export function pasteIntoTmux(socket: string, session: string, text: string, run: Runner = defaultRunner): DeliveryResult {
  const buffer = `isymcp-${session}`;
  const base = ["tmux", "-L", socket];
  const has = run([...base, "has-session", "-t", session]);
  if (has.code !== 0) return { delivered: false, reason: `tmux_session_missing: ${session}` };
  const load = run([...base, "load-buffer", "-b", buffer, "-"], text);
  if (load.code !== 0) return { delivered: false, reason: `tmux_load_failed: ${load.err}` };
  const paste = run([...base, "paste-buffer", "-p", "-d", "-b", buffer, "-t", session]);
  if (paste.code !== 0) return { delivered: false, reason: `tmux_paste_failed: ${paste.err}` };
  const enter = run([...base, "send-keys", "-t", session, "Enter"]);
  if (enter.code !== 0) return { delivered: false, reason: `tmux_enter_failed: ${enter.err}` };
  return { delivered: true, reason: "pasted" };
}

/**
 * ¿Esta consola recibe las tareas por inyección? (y no por su propio wait-next).
 * El estado (COMPLETED/FAILED) es el de su PRIMERA tarea: una consola que la terminó sigue
 * abierta y puede recibir más trabajo, como agy. Si ya se cerró lo dice tmux (has-session).
 */
export function consoleWantsInjection(rec: Pick<ConsoleRecord, "agent" | "tmux_session" | "tmux_socket">): boolean {
  const def = resolveAgentTui(rec.agent);
  if (!def || def.listener !== "inject") return false;
  return Boolean(rec.tmux_session && rec.tmux_socket);
}

export function buildTaskInjection(task: { task_id: string; kind: string; description: string }, isymcpCliPath: string): string {
  return [
    `[ISyMCP] Nueva tarea de ChatGPT para esta consola`,
    `TASK_ID: ${task.task_id} · tipo: ${task.kind}`,
    ``,
    task.description,
    ``,
    `Al terminar responde con:`,
    `bun run "${isymcpCliPath}" monitor respond ${task.task_id} --summary "<resultado y evidencia>"`,
  ].join("\n");
}

/** Entrega una tarea a la consola si corresponde; nunca lanza. */
export function deliverTaskToConsole(
  rec: ConsoleRecord,
  task: { task_id: string; kind: string; description: string },
  isymcpCliPath: string,
  run: Runner = defaultRunner,
): DeliveryResult {
  if (!consoleWantsInjection(rec)) return { delivered: false, reason: `listener_not_inject_or_no_tmux (${rec.agent})` };
  try {
    return pasteIntoTmux(rec.tmux_socket!, rec.tmux_session!, buildTaskInjection(task, isymcpCliPath), run);
  } catch (e) {
    return { delivered: false, reason: `delivery_error: ${(e as Error).message}` };
  }
}
