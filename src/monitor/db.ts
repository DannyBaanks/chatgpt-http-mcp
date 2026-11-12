// src/monitor/db.ts — Esquema SQLite transaccional del monitor y mapeo de filas de tareas.
// (Movido sin cambios desde src/remote-monitor.ts, 2026-11-12.)
import { ensureConsoleSchema } from "../console-registry";
import { Database } from "bun:sqlite";
import { TaskRecord, TaskState } from "./types";

/**
 * Inicializa el esquema SQLite transaccional del monitor remoto.
 */
export function openMonitorDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS used_owner_grants (
      grant_id TEXT PRIMARY KEY,
      used_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS used_worker_receipts (
      receipt_hmac TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      used_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leases (
      lease_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      fp TEXT NOT NULL,
      generation INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      audience TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      absolute_deadline INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS task_grants (
      grant_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      allowed_kinds_json TEXT NOT NULL,
      allowed_actions_json TEXT NOT NULL,
      max_runtime_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      goal_id TEXT NOT NULL,
      conversation_ref TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      description TEXT NOT NULL,
      requested_actions_json TEXT NOT NULL,
      target_relpath TEXT,
      idempotent INTEGER NOT NULL,
      state TEXT NOT NULL,
      reason TEXT NOT NULL,
      grant_id TEXT,
      worker_lease_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      result_json TEXT,
      receipt_hmac TEXT
    );
  `);
  ensureConsoleSchema(db);

  return db;
}

export function mapTaskRow(row: any): TaskRecord {
  return {
    task_id: String(row.task_id),
    operation_id: String(row.operation_id),
    idempotency_key: String(row.idempotency_key),
    goal_id: String(row.goal_id),
    conversation_ref: String(row.conversation_ref),
    lease_id: String(row.lease_id),
    workspace_id: String(row.workspace_id),
    kind: String(row.kind),
    description: String(row.description),
    requested_actions: JSON.parse(String(row.requested_actions_json)) as string[],
    target_relpath: row.target_relpath ? String(row.target_relpath) : null,
    idempotent: Number(row.idempotent) === 1,
    state: String(row.state) as TaskState,
    reason: String(row.reason),
    grant_id: row.grant_id ? String(row.grant_id) : null,
    worker_lease_id: row.worker_lease_id ? String(row.worker_lease_id) : null,
    attempt_count: Number(row.attempt_count),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    result: row.result_json ? JSON.parse(String(row.result_json)) : null,
    receipt_hmac: row.receipt_hmac ? String(row.receipt_hmac) : null,
  };
}
