// src/monitor/coordinator.ts — MonitorCoordinator: reconciliación, reclamo y cierre de tareas, bucle continuo.
// (Movido sin cambios desde src/remote-monitor.ts, 2026-11-12.)
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mapTaskRow } from "./db";
import { TaskRecord, TaskState, WorkerLease } from "./types";
import { WorkerAdapter } from "./worker";

/**
 * Coordinador del Monitor en Background (MonitorCoordinator).
 * Gestiona claim transaccional, transición a RUNNING, reconciliación tras caída
 * (estado UNKNOWN para tareas no idempotentes) y registro verificable de resultados.
 */
export class MonitorCoordinator {
  private readonly db: Database;
  private readonly worker: WorkerAdapter;
  private readonly nowFn: () => number;

  constructor(db: Database, worker: WorkerAdapter, options: { nowFn?: () => number } = {}) {
    this.db = db;
    this.worker = worker;
    this.worker.bindDatabase(db);
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  /**
   * Reconcilia tareas huérfanas al iniciar o recuperar el monitor tras un reinicio.
   * - Tareas en CLAIMED o RUNNING que no son idempotentes pasan a UNKNOWN (sin reintento ciego, A08).
   * - Tareas en CLAIMED que aún no ejecutaron efectos o marcadas idempotentes pueden volver a READY si su grant sigue vigente.
   */
  public reconcileOnStartup(): { markedUnknown: string[]; recoveredReady: string[] } {
    const markedUnknown: string[] = [];
    const recoveredReady: string[] = [];
    const now = this.nowFn();

    const tx = this.db.transaction(() => {
      const interrupted = this.db
        .query("SELECT * FROM tasks WHERE state IN ('CLAIMED', 'RUNNING')")
        .all() as any[];
      for (const row of interrupted) {
        const isIdempotent = Number(row.idempotent) === 1;
        if (row.state === "RUNNING" && !isIdempotent) {
          this.db
            .query(
              "UPDATE tasks SET state = 'UNKNOWN', reason = 'worker_crash_non_idempotent_no_blind_retry', updated_at = ? WHERE task_id = ?",
            )
            .run(now, row.task_id);
          markedUnknown.push(String(row.task_id));
        } else if (isIdempotent) {
          this.db
            .query(
              "UPDATE tasks SET state = 'READY', reason = 'recovered_idempotent_task', worker_lease_id = NULL, updated_at = ? WHERE task_id = ?",
            )
            .run(now, row.task_id);
          recoveredReady.push(String(row.task_id));
        } else {
          this.db
            .query(
              "UPDATE tasks SET state = 'UNKNOWN', reason = 'unverified_interrupted_state', updated_at = ? WHERE task_id = ?",
            )
            .run(now, row.task_id);
          markedUnknown.push(String(row.task_id));
        }
      }
    });

    tx.immediate();
    return { markedUnknown, recoveredReady };
  }

  /**
   * Reclama transaccionalmente la siguiente tarea READY y emite un WorkerLease de corta duración.
   * Si el lease o el task_grant fueron revocados antes del claim, cancela la tarea y no la reclama.
   */
  public claimNextReadyTask(): { task: TaskRecord; workerLease: WorkerLease } | null {
    const now = this.nowFn();
    const tx = this.db.transaction((): { task: TaskRecord; workerLease: WorkerLease } | null => {
      const candidates = this.db
        .query("SELECT * FROM tasks WHERE state = 'READY' ORDER BY created_at ASC")
        .all() as any[];

      for (const row of candidates) {
        const leaseRow = this.db
          .query("SELECT * FROM leases WHERE lease_id = ?")
          .get(row.lease_id) as any;
        const grantRow = row.grant_id
          ? (this.db.query("SELECT * FROM task_grants WHERE grant_id = ?").get(row.grant_id) as any)
          : null;

        // Si el lease fue revocado antes de reclamar, o el grant no existe/fue revocado/expiró, suspender (A05)
        if (
          !leaseRow ||
          leaseRow.revoked_at !== null ||
          !grantRow ||
          grantRow.revoked_at !== null ||
          now >= Number(grantRow.expires_at)
        ) {
          this.db
            .query(
              "UPDATE tasks SET state = 'CANCELLED', reason = 'authorization_revoked_or_expired_before_claim', updated_at = ? WHERE task_id = ?",
            )
            .run(now, row.task_id);
          continue;
        }

        const wsRow = this.db
          .query("SELECT * FROM workspaces WHERE workspace_id = ?")
          .get(row.workspace_id) as any;
        if (!wsRow) {
          this.db
            .query(
              "UPDATE tasks SET state = 'FAILED', reason = 'workspace_missing', updated_at = ? WHERE task_id = ?",
            )
            .run(now, row.task_id);
          continue;
        }

        const worker_lease_id = `wl-${randomBytes(8).toString("hex")}`;
        const workerLease = this.worker.signWorkerLease({
          kind: "worker_lease",
          worker_lease_id,
          task_id: String(row.task_id),
          operation_id: String(row.operation_id),
          workspace_id: String(row.workspace_id),
          workspace_root: String(wsRow.root_path),
          issued_at: now,
          expires_at: now + Number(grantRow.max_runtime_ms || 30_000),
        });

        const nextAttempt = Number(row.attempt_count) + 1;
        this.db
          .query(
            `UPDATE tasks
             SET state = 'RUNNING', reason = 'claimed_by_worker', worker_lease_id = ?, attempt_count = ?, updated_at = ?
             WHERE task_id = ?`,
          )
          .run(worker_lease_id, nextAttempt, now, row.task_id);

        const updatedRow = this.db
          .query("SELECT * FROM tasks WHERE task_id = ?")
          .get(row.task_id) as any;
        return {
          task: mapTaskRow(updatedRow),
          workerLease,
        };
      }
      return null;
    });

    return tx.immediate();
  }

  /**
   * Registra el resultado de una tarea en ejecución exigiendo un recibo criptográfico válido del WorkerAdapter (A11, B04).
   */
  public completeTask(receipt: unknown, targetTaskIdOverride?: string): TaskRecord {
    const validReceipt = this.worker.verifyExecutionReceipt(receipt);
    const now = this.nowFn();
    const targetTaskId = targetTaskIdOverride ?? validReceipt.task_id;

    const tx = this.db.transaction((): TaskRecord => {
      if (targetTaskId !== validReceipt.task_id) {
        throw new Error("DENY: receipt_task_id_mismatch");
      }

      const used = this.db
        .query("SELECT receipt_hmac FROM used_worker_receipts WHERE receipt_hmac = ?")
        .get(validReceipt.signature);
      if (used) {
        throw new Error("DENY: receipt_replay_detected");
      }

      const row = this.db
        .query("SELECT * FROM tasks WHERE task_id = ?")
        .get(validReceipt.task_id) as any;
      if (!row) {
        throw new Error("DENY: task_not_found");
      }
      if (row.operation_id !== validReceipt.operation_id) {
        throw new Error("DENY: receipt_operation_id_mismatch");
      }
      if (row.state !== "RUNNING" && row.state !== "CLAIMED") {
        throw new Error(`DENY: invalid_task_state_for_completion:${row.state}`);
      }
      if (row.worker_lease_id !== validReceipt.worker_lease_id) {
        throw new Error("DENY: receipt_worker_lease_mismatch");
      }

      this.db
        .query("INSERT INTO used_worker_receipts (receipt_hmac, task_id, used_at) VALUES (?, ?, ?)")
        .run(validReceipt.signature, validReceipt.task_id, now);

      const nextState: TaskState = validReceipt.exit_code === 0 ? "SUCCEEDED" : "FAILED";
      const reason = validReceipt.exit_code === 0 ? "execution_succeeded" : "execution_failed";
      const resultObj = {
        exit_code: validReceipt.exit_code,
        output_summary: validReceipt.output_summary,
        artifact_hash: validReceipt.artifact_hash,
        completed_at: validReceipt.completed_at,
      };

      this.db
        .query(
          `UPDATE tasks
           SET state = ?, reason = ?, result_json = ?, receipt_hmac = ?, updated_at = ?
           WHERE task_id = ?`,
        )
        .run(
          nextState,
          reason,
          JSON.stringify(resultObj),
          validReceipt.signature,
          now,
          validReceipt.task_id,
        );

      const updated = this.db
        .query("SELECT * FROM tasks WHERE task_id = ?")
        .get(validReceipt.task_id) as any;
      return mapTaskRow(updated);
    });

    return tx.immediate();
  }

  /**
   * Inspección administrativa local de cualquier tarea por task_id.
   */
  public inspectTask(taskId: string): TaskRecord | null {
    const row = this.db.query("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as any;
    return row ? mapTaskRow(row) : null;
  }

  /**
   * Lista todas las tareas persistidas en el buzón ordenadas por fecha de creación.
   */
  public listTasks(limit = 50): TaskRecord[] {
    const rows = this.db
      .query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map(mapTaskRow);
  }

  /**
   * Procesa en un ciclo todas las tareas que estén en estado READY en este instante
   * sin cerrar el monitor. Si alguna falla o es revocada justo antes del inicio,
   * captura el error de forma aislada y continúa con la siguiente tarea.
   */
  public drainReadyTasks(
    runner?: (
      task: TaskRecord,
      confinedTargetPath: string,
    ) => { exit_code: number; output_summary: string; artifact_hash: string },
    onTaskCompleted?: (task: TaskRecord) => void,
  ): TaskRecord[] {
    const completed: TaskRecord[] = [];
    while (true) {
      const claimed = this.claimNextReadyTask();
      if (!claimed) break;
      try {
        const receipt = this.worker.executeClaimedTask(
          claimed.workerLease,
          claimed.task,
          runner,
        );
        const done = this.completeTask(receipt);
        completed.push(done);
        onTaskCompleted?.(done);
      } catch (err: any) {
        // Si la autorización se revocó justo antes del inicio (C05), la tarea ya quedó en CANCELLED.
        // Para cualquier otro error inesperado del runner, el bucle del monitor NUNCA se cierra.
        const current = this.inspectTask(claimed.task.task_id);
        if (current) {
          completed.push(current);
          onTaskCompleted?.(current);
        }
      }
    }
    return completed;
  }

  /**
   * Inicia el bucle continuo residente del monitor (`always-on background loop`).
   * Reconcilia tareas huérfanas al arrancar y permanece activo indefinidamente
   * procesando nuevas tareas conforme llegan (y guardando sus respuestas) sin cerrarse jamás,
   * hasta que el propietario invoque explícitamente `stop()` (o mate el proceso con `isymcp monitor stop`).
   */
  public startContinuousLoop(options?: {
    pollIntervalMs?: number;
    runner?: (
      task: TaskRecord,
      confinedTargetPath: string,
    ) => { exit_code: number; output_summary: string; artifact_hash: string };
    onTaskCompleted?: (task: TaskRecord) => void;
  }): {
    readonly isRunning: () => boolean;
    readonly processedCount: () => number;
    readonly tickNow: () => TaskRecord[];
    readonly stop: () => void;
  } {
    const pollIntervalMs = Math.max(20, options?.pollIntervalMs ?? 500);
    this.reconcileOnStartup();

    let running = true;
    let totalProcessed = 0;
    let busy = false;

    const tickNow = (): TaskRecord[] => {
      if (!running || busy) return [];
      busy = true;
      try {
        const batch = this.drainReadyTasks(options?.runner, options?.onTaskCompleted);
        totalProcessed += batch.length;
        return batch;
      } finally {
        busy = false;
      }
    };

    // Primer barrido inmediato al arrancar
    tickNow();

    const timer = setInterval(() => {
      if (!running) return;
      tickNow();
    }, pollIntervalMs);

    return {
      isRunning: () => running,
      processedCount: () => totalProcessed,
      tickNow,
      stop: () => {
        if (!running) return;
        running = false;
        clearInterval(timer);
      },
    };
  }
}
