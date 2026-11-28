// src/hive/relay.ts — Relay del Hive: entrega cada mensaje que llega al inbox de un agente
// directamente a ese agente, sin que un humano tenga que decirle «lee tu inbox».
//
// Dos modos:
//   - "tmux": pega el mensaje en la TUI viva del agente (sesión tmux) con bracketed paste + Enter.
//     El agente responde él mismo con hive_talk (el texto inyectado le dice a quién).
//   - "exec": lanza una vez el CLI headless del agente (p. ej. `claude -p`, `gemini -p`, `codex exec -`)
//     con el mensaje por stdin, captura su stdout y lo devuelve como respuesta al remitente
//     (local o `agente@peer` por munder-link). Funciona igual en Linux y Windows.
//
// Antibucle: en modo exec solo se contesta a actos que piden respuesta (request/query/propose o
// requires_reply=true) y nunca a mensajes del propio agente; dos relays exec no se responden en ping-pong
// porque las respuestas viajan como act="inform".
import { spawn } from "node:child_process";
import { pasteIntoTmux, type DeliveryResult } from "../console-delivery";
import { remoteHiveDeliver } from "../link/client";
import { quoteForWindowsShell, type RelayAccess } from "./relay-access";
import { deliverLiveMessage, isPidAlive, registerLiveAgent, waitForAgentMessage, type LiveRegistryAgent } from "./live";
import type { HiveManager } from "./manager";
import type { HiveMessage } from "./types";

export type RelayMode = "tmux" | "exec";

export interface RelayOptions {
  agentId: string;
  mode: RelayMode;
  /** modo tmux: sesión destino y socket (-L). */
  tmuxSession?: string;
  tmuxSocket?: string;
  /** modo exec: argv del CLI headless; el mensaje entra por stdin. */
  execArgv?: string[];
  execCwd?: string;
  execEnv?: Record<string, string>;
  execTimeoutMs?: number;
  /** remitente que firma las respuestas (por defecto agentId). */
  replyFrom?: string;
  /** modo de acceso (src/hive/relay-access.ts); "custom" = argv propio tras `--`. */
  access?: RelayAccess | "custom";
  /** ms epoch: pasado este instante el relay deja de ejecutar (acceso full con --for). */
  expiresAt?: number | null;
  now?: () => number;
}

export interface RelayOutcome {
  message_id: string;
  from: string;
  action: "injected" | "executed" | "skipped" | "failed";
  reason: string;
  reply_id?: string | null;
}

export interface RelayDeps {
  paste?: (socket: string, session: string, text: string) => DeliveryResult;
  exec?: (argv: string[], stdin: string, opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number }) => Promise<ExecResult>;
  reply?: (to: string, payload: ReplyPayload) => Promise<string | null>;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ReplyPayload {
  from: string;
  subject: string;
  body: string;
  in_reply_to: string;
  conversation: string;
}

const REPLY_ACTS = new Set(["request", "query", "propose"]);
const MAX_REPLY_CHARS = 60_000;

/** ¿Debe el relay exec contestar a este mensaje? */
export function wantsReply(msg: HiveMessage): boolean {
  return msg.requires_reply === true || REPLY_ACTS.has(msg.act);
}

/** Texto que recibe el agente (TUI o stdin del CLI headless). */
export function buildRelayPrompt(msg: HiveMessage, agentId: string, mode: RelayMode): string {
  const lines = [
    `[Hive] Mensaje para ${agentId} de ${msg.from} (act=${msg.act}, id=${msg.id})`,
    `Asunto: ${msg.subject}`,
    "",
    msg.body || "(sin cuerpo)",
    "",
  ];
  if (mode === "tmux") {
    lines.push(
      `Responde con hive_talk(to="${msg.from}", from="${agentId}", in_reply_to="${msg.id}", conversation="${msg.conversation}").`,
    );
  } else {
    lines.push("Tu salida estándar se enviará tal cual como respuesta al remitente. Responde directamente.");
  }
  return lines.join("\n");
}

function defaultExec(argv: string[], stdin: string, opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number }): Promise<ExecResult> {
  return new Promise((resolve) => {
    // En Windows los CLIs de npm son .cmd: hace falta shell. El mensaje NUNCA va en argv, solo por stdin.
    const win = process.platform === "win32";
    const args = win ? argv.slice(1).map(quoteForWindowsShell) : argv.slice(1);
    const child = spawn(argv[0]!, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      shell: win,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_REPLY_CHARS * 2) stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 8_000) stderr += String(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(e.message), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {
      /* el CLI puede cerrar stdin antes de leerlo todo */
    });
    child.stdin.end(stdin);
  });
}

function makeDefaultReply(hive: HiveManager) {
  return async (to: string, p: ReplyPayload): Promise<string | null> => {
    const at = to.indexOf("@");
    if (at > 0 && at < to.length - 1) {
      const res = await remoteHiveDeliver(to.slice(at + 1), {
        to: to.slice(0, at),
        from: p.from,
        subject: p.subject,
        body: p.body,
        act: "inform",
        in_reply_to: p.in_reply_to,
        conversation: p.conversation,
      });
      const id = res.result?.message?.id;
      return typeof id === "string" ? id : null;
    }
    const msg = deliverLiveMessage(
      hive,
      { to, subject: p.subject, body: p.body, act: "inform", in_reply_to: p.in_reply_to, conversation: p.conversation },
      p.from,
    );
    return msg.id;
  };
}

/** Procesa UN mensaje según el modo del relay. Sin efectos fuera de deps (testeable). */
export async function relayMessage(
  hive: HiveManager,
  msg: HiveMessage,
  opts: RelayOptions,
  deps: RelayDeps = {},
): Promise<RelayOutcome> {
  const base = { message_id: msg.id, from: msg.from };
  const self = opts.replyFrom ?? opts.agentId;
  if (msg.from === opts.agentId || msg.from === self) {
    return { ...base, action: "skipped", reason: "own_message" };
  }

  if (opts.mode === "tmux") {
    if (!opts.tmuxSession) return { ...base, action: "failed", reason: "tmux_session_required" };
    const paste = deps.paste ?? ((s, sess, t) => pasteIntoTmux(s, sess, t));
    const r = paste(opts.tmuxSocket ?? "default", opts.tmuxSession, buildRelayPrompt(msg, opts.agentId, "tmux"));
    return { ...base, action: r.delivered ? "injected" : "failed", reason: r.reason };
  }

  if (!opts.execArgv?.length) return { ...base, action: "failed", reason: "exec_argv_required" };
  if (!wantsReply(msg)) return { ...base, action: "skipped", reason: `act_${msg.act}_no_reply` };
  const now = (opts.now ?? Date.now)();
  if (opts.expiresAt && now >= opts.expiresAt) return { ...base, action: "skipped", reason: "access_expired" };

  const exec = deps.exec ?? defaultExec;
  const res = await exec(opts.execArgv, buildRelayPrompt(msg, opts.agentId, "exec"), {
    cwd: opts.execCwd,
    env: opts.execEnv,
    timeoutMs: opts.execTimeoutMs ?? 600_000,
  });
  const ok = !res.timedOut && res.code === 0;
  let body = res.stdout.trim();
  if (!ok) {
    const why = res.timedOut ? "timeout" : `exit ${res.code}`;
    body = `[relay ${self}] el agente falló (${why}).\n${res.stderr.trim().slice(-2000)}\n${body}`.trim();
  }
  if (body.length > MAX_REPLY_CHARS) body = `${body.slice(0, MAX_REPLY_CHARS)}\n…[truncado]`;
  if (!body) body = "(el agente no produjo salida)";

  const reply = deps.reply ?? makeDefaultReply(hive);
  try {
    const replyId = await reply(msg.from, {
      from: self,
      subject: msg.subject.startsWith("Re: ") ? msg.subject : `Re: ${msg.subject}`,
      body,
      in_reply_to: msg.id,
      conversation: msg.conversation,
    });
    return { ...base, action: ok ? "executed" : "failed", reason: ok ? "replied" : "replied_with_error", reply_id: replyId };
  } catch (e) {
    return { ...base, action: "failed", reason: `reply_failed: ${(e as Error).message}` };
  }
}

/**
 * Bucle del relay: espera mensajes del agente (inbox en disco, sirve para entregas locales y
 * remotas de munder-link) y los procesa en orden, uno a uno. Termina cuando `signal` se aborta.
 */
export async function runRelay(
  hive: HiveManager,
  opts: RelayOptions,
  hooks: { signal?: AbortSignal; onOutcome?: (o: RelayOutcome) => void; deps?: RelayDeps } = {},
): Promise<void> {
  hive.ensureHive();
  // Sin inbox el Hive descarta el mensaje: registra al agente. Si ya hay una sesión viva con su PID
  // real se respeta; si no, el PID del relay marca que el agente es alcanzable mientras el relay corre.
  const prev = hive.registry().agents[opts.agentId] as LiveRegistryAgent | undefined;
  registerLiveAgent(hive, {
    agent_id: opts.agentId,
    name: prev?.name,
    cwd: prev?.cwd ?? opts.execCwd,
    pid: prev?.pid && isPidAlive(prev.pid) ? prev.pid : process.pid,
    wake: opts.mode === "tmux" ? "tui" : prev?.wake,
  });
  const now = opts.now ?? Date.now;
  while (!hooks.signal?.aborted) {
    if (opts.expiresAt && now() >= opts.expiresAt) {
      hive.appendLog({ kind: "relay-expired", agentId: opts.agentId, access: opts.access ?? null });
      hooks.onOutcome?.({ message_id: "-", from: "-", action: "skipped", reason: "access_expired_relay_stopped" });
      return;
    }
    const { messages } = await waitForAgentMessage(hive, opts.agentId, { timeoutMs: 5_000, markRead: true });
    for (const msg of messages) {
      const outcome = await relayMessage(hive, msg, opts, hooks.deps);
      hive.appendLog({ kind: "relay", agentId: opts.agentId, mode: opts.mode, access: opts.access ?? null, ...outcome });
      hooks.onOutcome?.(outcome);
    }
  }
}
