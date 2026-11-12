// src/monitor/worker.ts — WorkerAdapter: worker leases firmados, ejecución y recibos verificables.
// (Movido sin cambios desde src/remote-monitor.ts, 2026-11-12.)
import { hmacHex, safeEqualHex, sha256Prefixed } from "../crypto";
import { resolveWithinReal } from "../path";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { MonitorCoordinator } from "./coordinator";
import { TaskRecord, WorkerExecutionReceipt, WorkerLease } from "./types";

/**
 * Adaptador de ejecución confinada del Worker local.
 * Único componente que puede firmar recibos de ejecución verificables.
 */
export class WorkerAdapter {
  private readonly workerSecret: string;
  private readonly nowFn: () => number;
  private db: Database | undefined;

  constructor(options: { workerSecret: string; nowFn?: () => number; db?: Database }) {
    if (!options.workerSecret || options.workerSecret.trim().length < 16) {
      throw new Error("worker_secret_required");
    }
    this.workerSecret = options.workerSecret;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.db = options.db;
  }

  public bindDatabase(db: Database): void {
    this.db = db;
  }

  /**
   * Firma o verifica un WorkerLease emitido por el MonitorCoordinator.
   */
  public signWorkerLease(payload: Omit<WorkerLease, "signature">): WorkerLease {
    const canonical = JSON.stringify({
      kind: "worker_lease",
      worker_lease_id: payload.worker_lease_id,
      task_id: payload.task_id,
      operation_id: payload.operation_id,
      workspace_id: payload.workspace_id,
      workspace_root: payload.workspace_root,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
    });
    return {
      ...payload,
      signature: hmacHex(this.workerSecret, canonical),
    };
  }

  public verifyWorkerLease(lease: unknown): WorkerLease {
    if (!lease || typeof lease !== "object") {
      throw new Error("DENY: worker_lease_missing");
    }
    const wl = lease as Partial<WorkerLease>;
    if (wl.kind !== "worker_lease") {
      throw new Error("DENY: queue_lease_or_non_worker_credential_cannot_execute");
    }
    const now = this.nowFn();
    if (typeof wl.expires_at !== "number" || wl.expires_at <= now) {
      throw new Error("DENY: worker_lease_expired");
    }
    const canonical = JSON.stringify({
      kind: "worker_lease",
      worker_lease_id: wl.worker_lease_id,
      task_id: wl.task_id,
      operation_id: wl.operation_id,
      workspace_id: wl.workspace_id,
      workspace_root: wl.workspace_root,
      issued_at: wl.issued_at,
      expires_at: wl.expires_at,
    });
    const expected = hmacHex(this.workerSecret, canonical);
    if (typeof wl.signature !== "string" || !safeEqualHex(expected, wl.signature)) {
      throw new Error("DENY: worker_lease_invalid_signature");
    }
    return wl as WorkerLease;
  }

  /**
   * Ejecuta la acción confinada dentro del workspace_root autorizado y emite un recibo firmado.
   */
  public executeClaimedTask(
    workerLease: unknown,
    task: TaskRecord,
    runner?: (task: TaskRecord, workspaceRoot: string) => {
      exit_code: number;
      output_summary: string;
      artifact_hash: string;
    },
  ): WorkerExecutionReceipt {
    const validLease = this.verifyWorkerLease(workerLease);
    if (validLease.task_id !== task.task_id || validLease.operation_id !== task.operation_id) {
      throw new Error("DENY: worker_lease_task_mismatch");
    }

    // C05: Re-verificación autoritativa inmediatamente antes de iniciar el worker.
    // Si el QueueLease o el TaskGrant fue revocado después del claim pero antes de ejecutar, abortar fail-closed.
    if (this.db) {
      const now = this.nowFn();
      const checkOutcome = this.db.transaction((): "ok" | "not_running" | "revoked" => {
        const liveTask = this.db
          .query("SELECT * FROM tasks WHERE task_id = ?")
          .get(task.task_id) as any;
        if (
          !liveTask ||
          liveTask.state !== "RUNNING" ||
          liveTask.worker_lease_id !== validLease.worker_lease_id
        ) {
          return "not_running";
        }
        const liveLease = this.db
          .query("SELECT * FROM leases WHERE lease_id = ?")
          .get(liveTask.lease_id) as any;
        const liveGrant = liveTask.grant_id
          ? (this.db
              .query("SELECT * FROM task_grants WHERE grant_id = ?")
              .get(liveTask.grant_id) as any)
          : null;
        if (
          !liveLease ||
          liveLease.revoked_at !== null ||
          !liveGrant ||
          liveGrant.revoked_at !== null ||
          now >= Number(liveGrant.expires_at)
        ) {
          this.db
            .query(
              "UPDATE tasks SET state = 'CANCELLED', reason = 'authorization_revoked_after_claim_before_worker_start', updated_at = ? WHERE task_id = ?",
            )
            .run(now, task.task_id);
          return "revoked";
        }
        return "ok";
      });
      const status = checkOutcome.immediate();
      if (status === "not_running") {
        throw new Error("DENY: task_not_in_valid_running_state");
      }
      if (status === "revoked") {
        throw new Error("DENY: authorization_revoked_after_claim_before_worker_start");
      }
    }

    // Verificar confinamiento realpath antes de ejecutar
    const realRoot = realpathSync(validLease.workspace_root);
    if (task.target_relpath) {
      const targetReal = resolveWithinReal(realRoot, task.target_relpath);
      if (!targetReal) {
        throw new Error("DENY: worker_target_escapes_workspace");
      }
    }

    const outcome = runner
      ? runner(task, realRoot)
      : {
          exit_code: 0,
          output_summary: `Executed ${task.kind} (${task.requested_actions.join(",")}) in ${task.workspace_id}`,
          artifact_hash: sha256Prefixed(`${task.task_id}:${task.operation_id}:ok`),
        };

    const completed_at = this.nowFn();
    const receiptPayload = {
      task_id: task.task_id,
      operation_id: task.operation_id,
      worker_lease_id: validLease.worker_lease_id,
      exit_code: outcome.exit_code,
      output_summary: outcome.output_summary,
      artifact_hash: outcome.artifact_hash,
      completed_at,
    };
    const signature = hmacHex(this.workerSecret, JSON.stringify(receiptPayload));
    return {
      ...receiptPayload,
      signature,
    };
  }

  public verifyExecutionReceipt(receipt: unknown): WorkerExecutionReceipt {
    if (!receipt || typeof receipt !== "object") {
      throw new Error("DENY: execution_receipt_missing");
    }
    const r = receipt as Partial<WorkerExecutionReceipt>;
    if (
      typeof r.task_id !== "string" ||
      typeof r.operation_id !== "string" ||
      typeof r.worker_lease_id !== "string" ||
      typeof r.exit_code !== "number" ||
      typeof r.output_summary !== "string" ||
      typeof r.artifact_hash !== "string" ||
      typeof r.completed_at !== "number" ||
      typeof r.signature !== "string"
    ) {
      throw new Error("DENY: execution_receipt_malformed");
    }
    const canonical = JSON.stringify({
      task_id: r.task_id,
      operation_id: r.operation_id,
      worker_lease_id: r.worker_lease_id,
      exit_code: r.exit_code,
      output_summary: r.output_summary,
      artifact_hash: r.artifact_hash,
      completed_at: r.completed_at,
    });
    const expected = hmacHex(this.workerSecret, canonical);
    if (!safeEqualHex(expected, r.signature)) {
      throw new Error("DENY: execution_receipt_invalid_signature");
    }
    return r as WorkerExecutionReceipt;
  }
}
