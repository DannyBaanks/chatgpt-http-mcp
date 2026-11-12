// src/monitor/tasks.ts — ÚNICO lugar donde se crean y se responden filas de `tasks` del monitor.
//
// Antes había 5 INSERT copiados (tui-launcher x2, gateway monitor.submit, remote-monitor x2) y dos
// copias de "responder tarea" (gateway monitor.respond y `isymcp monitor respond`), cada una con su
// propio literal "[ARGON-ACK]". Una columna nueva o un cambio de semántica se hacía en un sitio y se
// olvidaba en los demás. Ahora todo pasa por aquí.
import type { Database } from "bun:sqlite";
import { sha256Prefixed } from "../crypto";

/** Marca que distingue una respuesta de agente de una tarea completada por el sistema (wait-next la busca). */
export const ACK_TAG = "[ARGON-ACK]";

/** Prefija el ACK_TAG si el resumen aún no lo trae. */
export function withAckTag(summary: string): string {
  return summary.includes(ACK_TAG) ? summary : `${ACK_TAG} ${summary}`;
}

/** ¿El resumen ya es una respuesta de agente? */
export function hasAckTag(summary: string | null | undefined): boolean {
  return Boolean(summary && summary.includes(ACK_TAG));
}

export interface TaskInsert {
  task_id: string;
  operation_id: string;
  idempotency_key: string;
  goal_id: string;
  conversation_ref: string;
  lease_id: string;
  workspace_id: string;
  kind: string;
  description: string;
  requested_actions: unknown[];
  target_relpath?: string | null;
  /** Por defecto true. */
  idempotent?: boolean;
  state: string;
  reason: string;
  grant_id?: string | null;
  worker_lease_id?: string | null;
  attempt_count?: number;
  created_at?: number;
  updated_at?: number;
  /** Se guarda como JSON. */
  result?: unknown;
  receipt_hmac?: string | null;
}

export interface InsertTaskOptions {
  /**
   * Si ya existe una tarea con ese task_id: la deja RUNNING con este `reason` (relanzar una consola
   * sobre una tarea existente). Sin esto, un task_id repetido es un error de SQLite.
   */
  onConflictRunning?: { reason: string };
}

const COLUMNS = [
  "task_id", "operation_id", "idempotency_key", "goal_id", "conversation_ref",
  "lease_id", "workspace_id", "kind", "description", "requested_actions_json",
  "target_relpath", "idempotent", "state", "reason", "grant_id", "worker_lease_id",
  "attempt_count", "created_at", "updated_at", "result_json", "receipt_hmac",
] as const;

/** Inserta una fila en `tasks` con todas sus columnas (valores por defecto explícitos). */
export function insertTask(db: Database, t: TaskInsert, opts: InsertTaskOptions = {}): void {
  const now = Date.now();
  const created = t.created_at ?? now;
  const values = [
    t.task_id, t.operation_id, t.idempotency_key, t.goal_id, t.conversation_ref,
    t.lease_id, t.workspace_id, t.kind, t.description, JSON.stringify(t.requested_actions),
    t.target_relpath ?? null, t.idempotent === false ? 0 : 1, t.state, t.reason, t.grant_id ?? null, t.worker_lease_id ?? null,
    t.attempt_count ?? 0, created, t.updated_at ?? created, t.result === undefined ? null : JSON.stringify(t.result), t.receipt_hmac ?? null,
  ];
  const placeholders = COLUMNS.map(() => "?").join(", ");
  const base = `INSERT INTO tasks (${COLUMNS.join(", ")}) VALUES (${placeholders})`;
  if (opts.onConflictRunning) {
    db.query(`${base} ON CONFLICT(task_id) DO UPDATE SET state = 'RUNNING', reason = ?, updated_at = ?`)
      .run(...values, opts.onConflictRunning.reason, created);
  } else {
    db.query(base).run(...values);
  }
}

export interface AckResult {
  exit_code: number;
  output_summary: string;
  artifact_hash: string;
  completed_at: number;
}

/**
 * Respuesta de un agente a una tarea (gateway monitor.respond y `isymcp monitor respond`):
 * la deja SUCCEEDED con el resumen marcado por ACK_TAG y su hash. Devuelve el resultado guardado.
 */
export function respondTask(db: Database, taskId: string, summary: string, now = Date.now()): AckResult {
  const output = withAckTag(summary);
  const result: AckResult = { exit_code: 0, output_summary: output, artifact_hash: sha256Prefixed(`${taskId}:${output}`), completed_at: now };
  db.query("UPDATE tasks SET state = 'SUCCEEDED', reason = 'argon_personal_response', result_json = ?, updated_at = ? WHERE task_id = ?")
    .run(JSON.stringify(result), now, taskId);
  return result;
}
