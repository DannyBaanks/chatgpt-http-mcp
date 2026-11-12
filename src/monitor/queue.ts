// src/monitor/queue.ts — QueueService: envío de tareas con queue lease y alertas del sistema.
// (Movido sin cambios desde src/remote-monitor.ts, 2026-11-12.)
import { resolveWithinReal } from "../path";
import { insertTask } from "./tasks";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { LeaseAuthority } from "./authority";
import { mapTaskRow } from "./db";
import { DEFAULT_QUOTA_CONFIG, ALLOWED_TASK_KINDS, QueueLeaseRecord, QueueSubmissionResponse, QueueTaskSubmission, QuotaConfig, SAFE_ACTION_RE, SAFE_IDENTIFIER_RE, TaskRecord, TaskState } from "./types";

/**
 * Servicio de buzón persistente (QueueService) + Motor de Políticas (PolicyEngine).
 */
export class QueueService {
  private readonly db: Database;
  private readonly authority: LeaseAuthority;
  private readonly quotas: QuotaConfig;
  private readonly nowFn: () => number;

  constructor(
    db: Database,
    authority: LeaseAuthority,
    options: { quotas?: Partial<QuotaConfig>; nowFn?: () => number } = {},
  ) {
    this.db = db;
    this.authority = authority;
    this.quotas = { ...DEFAULT_QUOTA_CONFIG, ...options.quotas };
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  /**
   * Encola una solicitud remota autenticada mediante un queue_lease.
   * Nunca inicia la ejecución directamente (`execution_started: false`).
   */
  public submitTask(submission: QueueTaskSubmission): QueueSubmissionResponse {
    const rawPayloadSize = Buffer.byteLength(JSON.stringify(submission ?? {}), "utf8");
    if (rawPayloadSize > this.quotas.maxPayloadBytes) {
      return this.deny(submission?.operation_id ?? "unknown", "quota_exceeded:payload_too_large");
    }

    if (
      !submission ||
      submission.schema_version !== 1 ||
      !SAFE_IDENTIFIER_RE.test(submission.operation_id || "") ||
      !SAFE_IDENTIFIER_RE.test(submission.idempotency_key || "") ||
      !SAFE_IDENTIFIER_RE.test(submission.goal_id || "") ||
      typeof submission.conversation_ref !== "string" ||
      !submission.task
    ) {
      return this.deny(submission?.operation_id ?? "unknown", "invalid_submission_schema");
    }

    let lease: QueueLeaseRecord;
    try {
      lease = this.authority.verifyQueueLeaseToken(submission.lease_token, "queue:submit");
    } catch (err: any) {
      return this.deny(submission.operation_id, String(err?.message ?? err));
    }

    const { task } = submission;
    if (task.workspace_id !== lease.workspace_id) {
      return this.deny(submission.operation_id, "DENY: workspace_substitution_forbidden");
    }

    if (
      typeof task.description !== "string" ||
      Buffer.byteLength(task.description, "utf8") > this.quotas.maxDescriptionBytes
    ) {
      return this.deny(submission.operation_id, "quota_exceeded:description_too_large");
    }

    if (
      !Array.isArray(task.requested_actions) ||
      task.requested_actions.length === 0 ||
      task.requested_actions.length > this.quotas.maxRequestedActions
    ) {
      return this.deny(submission.operation_id, "invalid_requested_actions_count");
    }

    if (!ALLOWED_TASK_KINDS.has(task.kind)) {
      return this.deny(submission.operation_id, `DENY: forbidden_task_kind:${task.kind}`);
    }

    for (const action of task.requested_actions) {
      if (
        typeof action !== "string" ||
        !SAFE_ACTION_RE.test(action) ||
        action.startsWith("shell:") ||
        action.startsWith("exec:")
      ) {
        return this.deny(submission.operation_id, `DENY: forbidden_requested_action:${String(action)}`);
      }
    }

    // Verificación transaccional de workspace, confinamiento realpath, idempotencia, cuotas y grants.
    const tx = this.db.transaction((): QueueSubmissionResponse => {
      // Re-verificar que el lease no haya sido revocado en carrera justo antes del commit (A05)
      const freshLease = this.db
        .query("SELECT revoked_at, expires_at, absolute_deadline FROM leases WHERE lease_id = ?")
        .get(lease.lease_id) as {
        revoked_at: number | null;
        expires_at: number;
        absolute_deadline: number;
      } | null;
      const now = this.nowFn();
      if (
        !freshLease ||
        freshLease.revoked_at !== null ||
        now >= freshLease.expires_at ||
        now >= freshLease.absolute_deadline
      ) {
        return this.deny(submission.operation_id, "DENY: lease_revoked_or_expired_in_race");
      }

      // Deduplicación idempotente por operation_id o idempotency_key (A06)
      const existing = this.db
        .query("SELECT * FROM tasks WHERE operation_id = ? OR idempotency_key = ?")
        .get(submission.operation_id, submission.idempotency_key) as any;
      if (existing) {
        return {
          operation_id: existing.operation_id,
          task_id: existing.task_id,
          state: existing.state as TaskState,
          accepted: true,
          execution_started: false,
          reason: existing.reason,
          result_ref: existing.result_json ? `result:${existing.task_id}` : null,
          deduplicated: true,
        };
      }

      // Verificar cuota de tareas pendientes (A13)
      const pendingCountRow = this.db
        .query(
          `SELECT COUNT(*) AS cnt FROM tasks
           WHERE workspace_id = ? AND state IN ('QUEUED', 'AWAITING_APPROVAL', 'READY', 'CLAIMED', 'RUNNING')`,
        )
        .get(lease.workspace_id) as { cnt: number };
      if (pendingCountRow.cnt >= this.quotas.maxPendingTasks) {
        return this.deny(submission.operation_id, "quota_exceeded:max_pending_tasks");
      }

      // Confinamiento de workspace y ruta objetivo (A09, A12)
      const ws = this.db
        .query("SELECT * FROM workspaces WHERE workspace_id = ?")
        .get(lease.workspace_id) as { workspace_id: string; owner_id: string; root_path: string } | null;
      if (!ws || ws.owner_id !== lease.owner_id) {
        return this.deny(submission.operation_id, "DENY: workspace_owner_integrity_failed");
      }

      if (task.target_relpath !== undefined) {
        if (
          !task.target_relpath ||
          isAbsolute(task.target_relpath) ||
          task.target_relpath.includes("\0") ||
          /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(task.target_relpath) ||
          task.target_relpath.split(/[\\/]/).includes("..")
        ) {
          return this.deny(submission.operation_id, "DENY: path_traversal_or_url_forbidden");
        }
        const resolvedTarget = resolveWithinReal(ws.root_path, task.target_relpath);
        if (!resolvedTarget) {
          return this.deny(submission.operation_id, "DENY: target_escapes_workspace_realpath");
        }
      }

      // Evaluar Policy Engine: ¿Existe un TaskGrant activo que cubra kind y todas las requested_actions?
      // Nota (A10): el texto en task.description o conversation_ref NUNCA concede autoridad.
      const grants = this.db
        .query(
          `SELECT * FROM task_grants
           WHERE workspace_id = ? AND owner_id = ? AND revoked_at IS NULL AND expires_at > ?`,
        )
        .all(lease.workspace_id, lease.owner_id, now) as any[];

      let matchedGrantId: string | null = null;
      for (const g of grants) {
        const allowedKinds: string[] = JSON.parse(g.allowed_kinds_json);
        const allowedActions: string[] = JSON.parse(g.allowed_actions_json);
        const kindOk = allowedKinds.includes(task.kind);
        const actionsOk = task.requested_actions.every((a) => allowedActions.includes(a));
        if (kindOk && actionsOk) {
          matchedGrantId = String(g.grant_id);
          break;
        }
      }

      const task_id = `task-${randomBytes(8).toString("hex")}`;
      const initialState: TaskState = matchedGrantId ? "READY" : "AWAITING_APPROVAL";
      const reason = matchedGrantId ? "authorized_by_task_grant" : "task_grant_required";
      const idempotentFlag = task.idempotent === false ? 0 : 1;

      insertTask(this.db, {
        task_id,
        operation_id: submission.operation_id,
        idempotency_key: submission.idempotency_key,
        goal_id: submission.goal_id,
        conversation_ref: submission.conversation_ref,
        lease_id: lease.lease_id,
        workspace_id: lease.workspace_id,
        kind: task.kind,
        description: task.description,
        requested_actions: task.requested_actions,
        target_relpath: task.target_relpath ?? null,
        idempotent: idempotentFlag === 1,
        state: initialState,
        reason,
        grant_id: matchedGrantId,
        created_at: now,
      });

      return {
        operation_id: submission.operation_id,
        task_id,
        state: initialState,
        accepted: true,
        execution_started: false,
        reason,
        result_ref: null,
      };
    });

    return tx.immediate();
  }

  /**
   * Encola una alerta o notificación del sistema (ej. GitHub CI, webhooks externos, hooks).
   * Se inserta en la cola SQLite WAL para despertar inmediatamente a los agentes suscritos (wait-next).
   */
  public submitAlertTask(alert: {
    source?: string;
    event?: string;
    title: string;
    summary: string;
    metadata?: Record<string, unknown>;
  }): { accepted: boolean; task_id: string; operation_id: string; state: TaskState } {
    const now = this.nowFn();
    const source = (alert.source || "system").toLowerCase();
    const taskId = `alert-${randomBytes(8).toString("hex")}`;
    const operationId = `op-alert-${randomBytes(8).toString("hex")}`;
    const idempotencyKey = `idemp-alert-${randomBytes(8).toString("hex")}`;

    let ws = this.db.query("SELECT workspace_id, owner_id FROM workspaces LIMIT 1").get() as {
      workspace_id: string;
      owner_id: string;
    } | null;
    let wsId = ws?.workspace_id;
    let ownerId = ws?.owner_id || (process.env.USER || "owner");
    if (!wsId) {
      wsId = "ws-system";
      this.db
        .query(
          "INSERT OR IGNORE INTO workspaces (workspace_id, owner_id, root_path, created_at) VALUES (?, ?, '/', ?)",
        )
        .run(wsId, ownerId, now);
    }

    let lease = this.db
      .query(
        "SELECT lease_id FROM leases WHERE workspace_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1",
      )
      .get(wsId, now) as { lease_id: string } | null;
    let leaseId = lease?.lease_id;
    if (!leaseId) {
      leaseId = `lease-alert-${randomBytes(6).toString("hex")}`;
      const tokenHash = `th_${randomBytes(16).toString("hex")}`;
      const fp = `fp_${randomBytes(8).toString("hex")}`;
      this.db
        .query(
          `INSERT OR IGNORE INTO leases (
            lease_id, token_hash, fp, generation, owner_id, workspace_id,
            scopes_json, audience, policy_version, created_at, expires_at, absolute_deadline, revoked_at
          ) VALUES (?, ?, ?, 1, ?, ?, '["alerts"]', 'isymcp_remote', 1, ?, ?, ?, NULL)`,
        )
        .run(leaseId, tokenHash, fp, ownerId, wsId, now, now + 86400000, now + 86400000);
    }

    const description = `[ALERT:${source.toUpperCase()}] ${alert.title}: ${alert.summary}`;
    const actionPayload = {
      action: "notify",
      source,
      event: alert.event ?? "alert",
      title: alert.title,
      summary: alert.summary,
      metadata: alert.metadata ?? {},
    };

    const resultObj = {
      exit_code: 0,
      output_summary: description,
      completed_at: now,
    };

    insertTask(this.db, {
      task_id: taskId,
      operation_id: operationId,
      idempotency_key: idempotencyKey,
      goal_id: "goal-alerts",
      conversation_ref: "ref-system-alerts",
      lease_id: leaseId,
      workspace_id: wsId,
      kind: "system_alert",
      description,
      requested_actions: [actionPayload],
      state: "SUCCEEDED",
      reason: "system_alert_notification",
      attempt_count: 1,
      created_at: now,
      result: resultObj,
    });

    return { accepted: true, task_id: taskId, operation_id: operationId, state: "SUCCEEDED" };
  }

  /**
   * Consulta el estado y resultado persistido de una tarea usando un queue_lease con scope `queue:status`.
   */
  public getTaskStatus(leaseToken: string, taskId: string): TaskRecord {
    const lease = this.authority.verifyQueueLeaseToken(leaseToken, "queue:status");
    const row = this.db.query("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as any;
    if (!row || row.workspace_id !== lease.workspace_id) {
      throw new Error("DENY: task_not_found_or_unauthorized");
    }
    return mapTaskRow(row);
  }

  private deny(operation_id: string, reason: string): QueueSubmissionResponse {
    return {
      operation_id,
      task_id: null,
      state: "DENIED",
      accepted: false,
      execution_started: false,
      reason,
      result_ref: null,
    };
  }
}
