// src/monitor/types.ts — Tipos, políticas por defecto y validaciones del monitor remoto.
// (Movido sin cambios desde src/remote-monitor.ts, 2026-11-12.)


export type AuthorityKind = "turn_token" | "queue_lease" | "worker_lease" | "owner_grant";

export type QueueLeaseScope = "queue:submit" | "queue:status";

export type OwnerGrantScope =
  | "lease:mint"
  | "lease:renew"
  | "lease:revoke"
  | "task:grant"
  | "task:revoke"
  | "workspace:register"
  | "operator:confirm";

export type TaskState =
  | "QUEUED"
  | "AWAITING_APPROVAL"
  | "READY"
  | "CLAIMED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

export interface LeasePolicyConfig {
  defaultTtlSeconds: number;
  maxInitialTtlSeconds: number;
  absoluteLifetimeSeconds: number;
}

export const DEFAULT_LEASE_POLICY: LeasePolicyConfig = {
  defaultTtlSeconds: 7200, // 2 hours
  maxInitialTtlSeconds: 86400, // 24 hours
  absoluteLifetimeSeconds: 86400, // 24 hours hard ceiling
};

export interface QuotaConfig {
  maxPendingTasks: number;
  maxDescriptionBytes: number;
  maxPayloadBytes: number;
  maxRequestedActions: number;
}

export const DEFAULT_QUOTA_CONFIG: QuotaConfig = {
  maxPendingTasks: 50,
  maxDescriptionBytes: 2048,
  maxPayloadBytes: 16384,
  maxRequestedActions: 8,
};

export interface OwnerGrant {
  readonly kind: "owner_grant";
  readonly grant_id: string;
  readonly owner_id: string;
  readonly scopes: OwnerGrantScope[];
  readonly issued_at: number;
  readonly expires_at: number;
  readonly nonce: string;
  readonly signature: string;
}

export interface QueueLeaseRecord {
  readonly kind: "queue_lease";
  readonly lease_id: string;
  readonly fp: string;
  readonly generation: number;
  readonly owner_id: string;
  readonly workspace_id: string;
  readonly scopes: QueueLeaseScope[];
  readonly audience: "isymcp-queue";
  readonly policy_version: number;
  readonly created_at: number;
  readonly expires_at: number;
  readonly absolute_deadline: number;
  readonly revoked_at: number | null;
}

export interface MintedQueueLease extends QueueLeaseRecord {
  /** El token opaco solo se devuelve en el momento de emisión. */
  readonly token: string;
}

export interface TaskGrantRecord {
  readonly grant_id: string;
  readonly owner_id: string;
  readonly workspace_id: string;
  readonly allowed_kinds: string[];
  readonly allowed_actions: string[];
  readonly max_runtime_ms: number;
  readonly created_at: number;
  readonly expires_at: number;
  readonly revoked_at: number | null;
}

export interface WorkerLease {
  readonly kind: "worker_lease";
  readonly worker_lease_id: string;
  readonly task_id: string;
  readonly operation_id: string;
  readonly workspace_id: string;
  readonly workspace_root: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly signature: string;
}

export interface QueueTaskSubmission {
  schema_version: 1;
  operation_id: string;
  goal_id: string;
  conversation_ref: string;
  lease_token: string;
  task: {
    kind: string;
    workspace_id: string;
    description: string;
    requested_actions: string[];
    target_relpath?: string;
    idempotent?: boolean;
  };
  idempotency_key: string;
  requested_at: string;
}

export interface QueueSubmissionResponse {
  operation_id: string;
  task_id: string | null;
  state: TaskState | "DENIED";
  accepted: boolean;
  execution_started: false;
  reason: string;
  result_ref: string | null;
  deduplicated?: boolean;
}

export interface WorkerExecutionReceipt {
  task_id: string;
  operation_id: string;
  worker_lease_id: string;
  exit_code: number;
  output_summary: string;
  artifact_hash: string;
  completed_at: number;
  signature: string;
}

export interface TaskRecord {
  task_id: string;
  operation_id: string;
  idempotency_key: string;
  goal_id: string;
  conversation_ref: string;
  lease_id: string;
  workspace_id: string;
  kind: string;
  description: string;
  requested_actions: string[];
  target_relpath: string | null;
  idempotent: boolean;
  state: TaskState;
  reason: string;
  grant_id: string | null;
  worker_lease_id: string | null;
  attempt_count: number;
  created_at: number;
  updated_at: number;
  result: {
    exit_code: number;
    output_summary: string;
    artifact_hash: string;
    completed_at: number;
  } | null;
  receipt_hmac: string | null;
}


export const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

export const SAFE_ACTION_RE = /^[a-z0-9_]+:[a-z0-9_]+$/;

export const ALLOWED_TASK_KINDS = new Set(["review_and_test", "verify_only", "diagnostics"]);
