// src/console-registry.ts — Registro determinista de consolas TUI lanzadas por ISyMCP.
//
// Cada consola tiene identidad propia e inmutable (console_id), un ack_token
// (solo se guarda su sha256 en SQLite; el texto va a un archivo 0600 que el
// wrapper exporta al agente), el PID REAL del agente (lo escribe el wrapper antes
// de `exec`), y un log JSONL append-only. GPT consulta todo con
// tui.consoles / tui.log sin adivinar qué ventana es cuál.
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "./codex-sessions";
import { hmacHex, randomHex, sha256Hex } from "./crypto";

export type ConsoleState = "SPAWNED" | "ACKED" | "RUNNING" | "COMPLETED" | "FAILED";

export interface ConsoleRecord {
  console_id: string;
  task_id: string;
  operation_id: string;
  title: string;
  cwd: string;
  workspace_id: string;
  terminal: string;
  tmux_session: string | null;
  agent_pid: number | null;
  launcher_pid: number | null;
  alive: boolean | null;
  state: ConsoleState;
  token_fp: string;
  created_at: number;
  ack_at: number | null;
  ack_summary: string | null;
  ack_hmac: string | null;
  last_event_at: number;
  events_count: number;
  log_path: string;
}

const CONSOLE_ID_RE = /^con-[a-f0-9]{8}$/;

export function consolesDir(env: Record<string, string | undefined> = process.env): string {
  const dir = join(bridgeHome(env), "consoles");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function ensureConsoleSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS console_sessions (
      console_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      terminal TEXT NOT NULL DEFAULT '',
      tmux_session TEXT,
      agent_pid INTEGER,
      launcher_pid INTEGER,
      state TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      token_fp TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ack_at INTEGER,
      ack_summary TEXT,
      ack_hmac TEXT,
      last_event_at INTEGER NOT NULL,
      events_count INTEGER NOT NULL DEFAULT 0,
      log_path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_console_task ON console_sessions(task_id);
  `);
}

export function pidAlive(pid: number | null | undefined): boolean | null {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

export interface NewConsole {
  console_id: string;
  ack_token: string;
  token_fp: string;
  log_path: string;
  token_file: string;
  pid_file: string;
}

/** Reserva identidad + archivos de una consola (aún sin PID). */
export function createConsole(
  db: Database,
  p: { taskId: string; operationId: string; title: string; cwd: string; workspaceId: string; terminal?: string; now?: number },
  env: Record<string, string | undefined> = process.env,
): NewConsole {
  ensureConsoleSchema(db);
  const now = p.now ?? Date.now();
  const console_id = `con-${randomBytes(4).toString("hex")}`;
  const ack_token = `ctk_${randomBytes(24).toString("base64url")}`;
  const token_hash = sha256Hex(ack_token);
  const token_fp = token_hash.slice(0, 12);
  const dir = consolesDir(env);
  const log_path = join(dir, `${console_id}.jsonl`);
  const token_file = join(dir, `${console_id}.token`);
  const pid_file = join(dir, `${console_id}.pid`);
  writeFileSync(token_file, `${ack_token}\n`, { mode: 0o600 });
  db.query(
    `INSERT INTO console_sessions (console_id, task_id, operation_id, title, cwd, workspace_id, terminal, state, token_hash, token_fp,
       created_at, last_event_at, events_count, log_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'SPAWNED', ?, ?, ?, ?, 0, ?)`,
  ).run(console_id, p.taskId, p.operationId, p.title, p.cwd, p.workspaceId, p.terminal ?? "", token_hash, token_fp, now, now, log_path);
  appendConsoleEvent(db, console_id, "SPAWN_REQUESTED", { task_id: p.taskId, operation_id: p.operationId, cwd: p.cwd, token_fp }, now);
  return { console_id, ack_token, token_fp, log_path, token_file, pid_file };
}

export function appendConsoleEvent(db: Database, consoleId: string, event: string, data: Record<string, unknown> = {}, now = Date.now()): void {
  ensureConsoleSchema(db);
  const row = db.query("SELECT log_path, events_count FROM console_sessions WHERE console_id = ?").get(consoleId) as
    | { log_path: string; events_count: number }
    | null;
  if (!row) throw new Error(`DENY: console_not_found:${consoleId}`);
  const line = { seq: Number(row.events_count) + 1, ts: new Date(now).toISOString(), console_id: consoleId, event, ...data };
  appendFileSync(row.log_path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  db.query("UPDATE console_sessions SET events_count = events_count + 1, last_event_at = ? WHERE console_id = ?").run(now, consoleId);
}

export function setLaunchInfo(
  db: Database,
  consoleId: string,
  info: { launcherPid?: number; terminal?: string; tmuxSession?: string | null },
): void {
  db.query(
    "UPDATE console_sessions SET launcher_pid = COALESCE(?, launcher_pid), terminal = COALESCE(?, terminal), tmux_session = COALESCE(?, tmux_session) WHERE console_id = ?",
  ).run(info.launcherPid ?? null, info.terminal ?? null, info.tmuxSession ?? null, consoleId);
  appendConsoleEvent(db, consoleId, "LAUNCHED", { ...info });
}

/** Lee el PID real que escribió el wrapper (`echo $$ > pidfile; exec agy`) y lo persiste. */
export function syncAgentPid(db: Database, consoleId: string, env: Record<string, string | undefined> = process.env): number | null {
  const row = db.query("SELECT agent_pid FROM console_sessions WHERE console_id = ?").get(consoleId) as { agent_pid: number | null } | null;
  if (!row) return null;
  if (row.agent_pid) return Number(row.agent_pid);
  const pidFile = join(consolesDir(env), `${consoleId}.pid`);
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  db.query("UPDATE console_sessions SET agent_pid = ? WHERE console_id = ?").run(pid, consoleId);
  appendConsoleEvent(db, consoleId, "AGENT_PID_REGISTERED", { agent_pid: pid });
  return pid;
}

export type ConsoleAckKind = "ack" | "progress" | "complete" | "fail";

/**
 * Registra un evento firmado de una consola. Exige console_id + ack_token (hash comparado);
 * el ACK de arranque deja la consola en ACKED y NUNCA cierra la tarea.
 */
export function consoleReport(
  db: Database,
  p: { consoleId: string; token: string; kind: ConsoleAckKind; summary: string; pid?: number; hmacSecret: string },
  env: Record<string, string | undefined> = process.env,
): ConsoleRecord {
  ensureConsoleSchema(db);
  if (!CONSOLE_ID_RE.test(p.consoleId)) throw new Error("DENY: invalid_console_id");
  const row = db.query("SELECT * FROM console_sessions WHERE console_id = ?").get(p.consoleId) as any;
  if (!row) throw new Error("DENY: console_not_found");
  if (sha256Hex(p.token || "") !== row.token_hash) throw new Error("DENY: console_token_mismatch");
  if (row.state === "COMPLETED" || row.state === "FAILED") throw new Error(`DENY: console_already_${String(row.state).toLowerCase()}`);
  if (p.kind === "ack" && row.ack_at) throw new Error("DENY: console_already_acked");
  const now = Date.now();
  const hmac = hmacHex(
    p.hmacSecret,
    JSON.stringify({ console_id: p.consoleId, task_id: row.task_id, kind: p.kind, summary: p.summary, ts: now }),
  );
  if (p.pid && Number.isInteger(p.pid) && p.pid > 0) {
    db.query("UPDATE console_sessions SET agent_pid = ? WHERE console_id = ?").run(p.pid, p.consoleId);
  } else {
    syncAgentPid(db, p.consoleId, env);
  }
  const nextState: ConsoleState = p.kind === "ack" ? "ACKED" : p.kind === "progress" ? "RUNNING" : p.kind === "complete" ? "COMPLETED" : "FAILED";
  if (p.kind === "ack") {
    db.query("UPDATE console_sessions SET state = ?, ack_at = ?, ack_summary = ?, ack_hmac = ? WHERE console_id = ?").run(
      nextState, now, p.summary, hmac, p.consoleId,
    );
  } else {
    db.query("UPDATE console_sessions SET state = ? WHERE console_id = ?").run(nextState, p.consoleId);
  }
  appendConsoleEvent(db, p.consoleId, p.kind.toUpperCase(), { summary: p.summary, hmac, token_fp: row.token_fp }, now);
  // La tarea solo se cierra con complete/fail; ack y progress la dejan RUNNING (nunca SUCCEEDED prematuro).
  if (p.kind === "complete" || p.kind === "fail") {
    const text = p.summary.includes("[ARGON-ACK]") ? p.summary : `[ARGON-ACK] ${p.summary}`;
    const result = {
      exit_code: p.kind === "complete" ? 0 : 1,
      output_summary: text,
      artifact_hash: `sha256:${sha256Hex(`${row.task_id}:${text}`)}`,
      completed_at: now,
    };
    db.query(
      "UPDATE tasks SET state = ?, reason = ?, result_json = ?, receipt_hmac = ?, updated_at = ? WHERE task_id = ?",
    ).run(p.kind === "complete" ? "SUCCEEDED" : "FAILED", `console_${p.kind}`, JSON.stringify(result), hmac, now, row.task_id);
  } else {
    db.query("UPDATE tasks SET state = 'RUNNING', reason = ?, updated_at = ? WHERE task_id = ? AND state IN ('RUNNING','CLAIMED','READY')")
      .run(`console_${p.kind}`, now, row.task_id);
  }
  return getConsole(db, p.consoleId, env)!;
}

function mapRow(row: any, alive: boolean | null): ConsoleRecord {
  return {
    console_id: row.console_id,
    task_id: row.task_id,
    operation_id: row.operation_id,
    title: row.title,
    cwd: row.cwd,
    workspace_id: row.workspace_id,
    terminal: row.terminal,
    tmux_session: row.tmux_session ?? null,
    agent_pid: row.agent_pid != null ? Number(row.agent_pid) : null,
    launcher_pid: row.launcher_pid != null ? Number(row.launcher_pid) : null,
    alive,
    state: row.state as ConsoleState,
    token_fp: row.token_fp,
    created_at: Number(row.created_at),
    ack_at: row.ack_at != null ? Number(row.ack_at) : null,
    ack_summary: row.ack_summary ?? null,
    ack_hmac: row.ack_hmac ? String(row.ack_hmac).slice(0, 16) + "…" : null,
    last_event_at: Number(row.last_event_at),
    events_count: Number(row.events_count),
    log_path: row.log_path,
  };
}

export function getConsole(db: Database, idOrTask: string, env: Record<string, string | undefined> = process.env): ConsoleRecord | null {
  ensureConsoleSchema(db);
  const row = db
    .query("SELECT * FROM console_sessions WHERE console_id = ? OR task_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(idOrTask, idOrTask) as any;
  if (!row) return null;
  const pid = syncAgentPid(db, row.console_id, env) ?? (row.agent_pid != null ? Number(row.agent_pid) : null);
  return mapRow({ ...row, agent_pid: pid }, pidAlive(pid));
}

export function listConsoles(db: Database, limit = 20, env: Record<string, string | undefined> = process.env): ConsoleRecord[] {
  ensureConsoleSchema(db);
  const rows = db.query("SELECT console_id FROM console_sessions ORDER BY created_at DESC LIMIT ?").all(limit) as { console_id: string }[];
  return rows.map((r) => getConsole(db, r.console_id, env)!).filter(Boolean);
}

export function readConsoleLog(db: Database, idOrTask: string, tail = 50): { console: ConsoleRecord; events: unknown[] } {
  const rec = getConsole(db, idOrTask);
  if (!rec) throw new Error(`console_not_found:${idOrTask}`);
  const events: unknown[] = [];
  if (existsSync(rec.log_path)) {
    for (const line of readFileSync(rec.log_path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { events.push({ event: "UNPARSEABLE_LINE", raw: line.slice(0, 200) }); }
    }
  }
  const n = Math.max(1, Math.min(500, Math.trunc(tail) || 50));
  return { console: rec, events: events.slice(-n) };
}

/** Script que ejecuta la terminal: registra el PID real y exporta identidad antes de `exec`. */
export const CONSOLE_WRAPPER_SCRIPT =
  'echo $$ > "$ISYMCP_CONSOLE_PID_FILE"; export ISYMCP_ACK_TOKEN="$(cat "$ISYMCP_CONSOLE_TOKEN_FILE")"; exec "$@"';

export function wrapperArgv(c: NewConsole, ids: { taskId: string; operationId: string; monitorUrl: string }, inner: string[]): string[] {
  return [
    "env",
    `ISYMCP_CONSOLE_ID=${c.console_id}`,
    `ISYMCP_CONSOLE_PID_FILE=${c.pid_file}`,
    `ISYMCP_CONSOLE_TOKEN_FILE=${c.token_file}`,
    `ISYMCP_TASK_ID=${ids.taskId}`,
    `ISYMCP_OPERATION_ID=${ids.operationId}`,
    `ISYMCP_MONITOR_URL=${ids.monitorUrl}`,
    "bash", "-c", CONSOLE_WRAPPER_SCRIPT, "isymcp-console",
    ...inner,
  ];
}
