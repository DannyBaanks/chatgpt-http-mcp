// src/remote-monitor.ts — GOAL-002: ISyMCP Remote Task Monitor
//
// Implementa el monitor residente con buzón persistente (SQLite), separación
// estricta de 4 clases de autoridad (turn_token, queue_lease, worker_lease, owner_grant),
// TTL renovable acotado por absolute_deadline, revocación transaccional inmediata,
// confinamiento realpath de workspaces y reconciliación segura (estado UNKNOWN
// sin reintento ciego para operaciones no idempotentes).

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { bridgeHome } from "./codex-sessions";
import { ensureConsoleSchema } from "./console-registry";
import { hmacHex, safeEqualHex, sha256Hex } from "./crypto";
import { resolveWithinReal } from "./path";

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

export { hmacHex, safeEqualHex, sha256Hex };

const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const SAFE_ACTION_RE = /^[a-z0-9_]+:[a-z0-9_]+$/;
const ALLOWED_TASK_KINDS = new Set(["review_and_test", "verify_only", "diagnostics"]);

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

/**
 * Autoridad de propietario y emisora/verificadora de leases y grants.
 */
export class LeaseAuthority {
  private readonly db: Database;
  private readonly ownerSecret: string;
  private readonly policy: LeasePolicyConfig;
  private readonly nowFn: () => number;

  constructor(
    db: Database,
    options: {
      ownerSecret: string;
      policy?: Partial<LeasePolicyConfig>;
      nowFn?: () => number;
    },
  ) {
    if (!options.ownerSecret || options.ownerSecret.trim().length < 16) {
      throw new Error("owner_secret_required: ownerSecret must be at least 16 characters");
    }
    this.db = db;
    this.ownerSecret = options.ownerSecret;
    this.policy = { ...DEFAULT_LEASE_POLICY, ...options.policy };
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  /**
   * Acuña un owner_grant firmado de un solo uso para una operación administrativa local.
   */
  public mintOwnerGrant(params: {
    owner_id: string;
    scopes: OwnerGrantScope[];
    ttlSeconds?: number;
  }): OwnerGrant {
    if (!SAFE_IDENTIFIER_RE.test(params.owner_id)) {
      throw new Error("invalid_owner_id");
    }
    if (!Array.isArray(params.scopes) || params.scopes.length === 0) {
      throw new Error("owner_grant_scopes_required");
    }
    const now = this.nowFn();
    const ttlMs = (params.ttlSeconds ?? 300) * 1000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 3600_000) {
      throw new Error("invalid_owner_grant_ttl");
    }
    const grant_id = `og-${randomBytes(8).toString("hex")}`;
    const nonce = randomBytes(16).toString("hex");
    const expires_at = now + ttlMs;
    const canonical = JSON.stringify({
      kind: "owner_grant",
      grant_id,
      owner_id: params.owner_id,
      scopes: [...params.scopes].sort(),
      issued_at: now,
      expires_at,
      nonce,
    });
    const signature = hmacHex(this.ownerSecret, canonical);
    return {
      kind: "owner_grant",
      grant_id,
      owner_id: params.owner_id,
      scopes: [...params.scopes],
      issued_at: now,
      expires_at,
      nonce,
      signature,
    };
  }

  /**
   * Verifica y consume (uso único) un owner_grant para el scope requerido.
   */
  public consumeOwnerGrant(grant: unknown, requiredScope: OwnerGrantScope): { owner_id: string } {
    if (!grant || typeof grant !== "object") {
      throw new Error("DENY: owner_grant_missing");
    }
    const g = grant as Partial<OwnerGrant>;
    if (
      g.kind !== "owner_grant" ||
      typeof g.grant_id !== "string" ||
      typeof g.owner_id !== "string" ||
      !Array.isArray(g.scopes) ||
      typeof g.issued_at !== "number" ||
      typeof g.expires_at !== "number" ||
      typeof g.nonce !== "string" ||
      typeof g.signature !== "string"
    ) {
      throw new Error("DENY: owner_grant_malformed");
    }
    const now = this.nowFn();
    if (g.expires_at <= now) {
      throw new Error("DENY: owner_grant_expired");
    }
    if (!g.scopes.includes(requiredScope)) {
      throw new Error(`DENY: owner_grant_missing_scope:${requiredScope}`);
    }
    const canonical = JSON.stringify({
      kind: "owner_grant",
      grant_id: g.grant_id,
      owner_id: g.owner_id,
      scopes: [...g.scopes].sort(),
      issued_at: g.issued_at,
      expires_at: g.expires_at,
      nonce: g.nonce,
    });
    const expectedSig = hmacHex(this.ownerSecret, canonical);
    if (!safeEqualHex(expectedSig, g.signature)) {
      throw new Error("DENY: owner_grant_invalid_signature");
    }

    const tx = this.db.transaction(() => {
      const existing = this.db
        .query("SELECT grant_id FROM used_owner_grants WHERE grant_id = ?")
        .get(g.grant_id!);
      if (existing) {
        throw new Error("DENY: owner_grant_replay_detected");
      }
      this.db
        .query("INSERT INTO used_owner_grants (grant_id, used_at) VALUES (?, ?)")
        .run(g.grant_id!, now);
    });
    tx.immediate();
    return { owner_id: g.owner_id };
  }

  /**
   * Registra un workspace confinado a un directorio real en disco.
   */
  public registerWorkspace(
    ownerGrant: OwnerGrant,
    params: { workspace_id: string; root_path: string },
  ): { workspace_id: string; owner_id: string; root_path: string } {
    const { owner_id } = this.consumeOwnerGrant(ownerGrant, "workspace:register");
    if (!SAFE_IDENTIFIER_RE.test(params.workspace_id)) {
      throw new Error("DENY: invalid_workspace_id");
    }
    if (!params.root_path || !isAbsolute(params.root_path) || !existsSync(params.root_path)) {
      throw new Error("DENY: workspace_root_must_exist_and_be_absolute");
    }
    const realRoot = realpathSync(params.root_path);
    if (!statSync(realRoot).isDirectory()) {
      throw new Error("DENY: workspace_root_not_directory");
    }
    const now = this.nowFn();
    this.db
      .query(
        `INSERT OR REPLACE INTO workspaces (workspace_id, owner_id, root_path, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(params.workspace_id, owner_id, realRoot, now);
    return { workspace_id: params.workspace_id, owner_id, root_path: realRoot };
  }

  /**
   * Emite un queue_lease acotado en tiempo y scopes (nunca permite ejecución).
   */
  public mintQueueLease(
    ownerGrant: OwnerGrant,
    params: {
      workspace_id: string;
      scopes?: QueueLeaseScope[];
      ttlSeconds?: number;
      absoluteLifetimeSeconds?: number;
    },
  ): MintedQueueLease {
    const { owner_id } = this.consumeOwnerGrant(ownerGrant, "lease:mint");
    const ws = this.db
      .query("SELECT workspace_id, owner_id FROM workspaces WHERE workspace_id = ?")
      .get(params.workspace_id) as { workspace_id: string; owner_id: string } | null;
    if (!ws) {
      throw new Error("DENY: workspace_not_registered");
    }
    if (ws.owner_id !== owner_id) {
      throw new Error("DENY: workspace_owner_mismatch");
    }

    const ttlSeconds = params.ttlSeconds ?? this.policy.defaultTtlSeconds;
    if (
      !Number.isFinite(ttlSeconds) ||
      ttlSeconds <= 0 ||
      ttlSeconds > this.policy.maxInitialTtlSeconds
    ) {
      throw new Error("DENY: invalid_or_excessive_lease_ttl");
    }

    const absSeconds = params.absoluteLifetimeSeconds ?? this.policy.absoluteLifetimeSeconds;
    if (
      !Number.isFinite(absSeconds) ||
      absSeconds < ttlSeconds ||
      absSeconds > this.policy.absoluteLifetimeSeconds
    ) {
      throw new Error("DENY: invalid_or_excessive_absolute_deadline");
    }

    const scopes: QueueLeaseScope[] = params.scopes ?? ["queue:submit", "queue:status"];
    if (scopes.length === 0) {
      throw new Error("DENY: empty_lease_scopes");
    }
    for (const s of scopes) {
      if (s !== "queue:submit" && s !== "queue:status") {
        throw new Error(`DENY: forbidden_queue_lease_scope:${String(s)}`);
      }
    }

    const now = this.nowFn();
    const absolute_deadline = now + absSeconds * 1000;
    const expires_at = Math.min(now + ttlSeconds * 1000, absolute_deadline);
    const token = `ql_${randomBytes(32).toString("base64url")}`;
    const token_hash = sha256Hex(token);
    const fp = token_hash.slice(0, 12);
    const lease_id = `lease-${fp}`;

    this.db
      .query(
        `INSERT INTO leases (
          lease_id, token_hash, fp, generation, owner_id, workspace_id,
          scopes_json, audience, policy_version, created_at, expires_at, absolute_deadline, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        lease_id,
        token_hash,
        fp,
        1,
        owner_id,
        params.workspace_id,
        JSON.stringify(scopes),
        "isymcp-queue",
        1,
        now,
        expires_at,
        absolute_deadline,
      );

    return {
      kind: "queue_lease",
      lease_id,
      token,
      fp,
      generation: 1,
      owner_id,
      workspace_id: params.workspace_id,
      scopes,
      audience: "isymcp-queue",
      policy_version: 1,
      created_at: now,
      expires_at,
      absolute_deadline,
      revoked_at: null,
    };
  }

  /**
   * Renueva un queue_lease existente.
   * Reglas:
   * - Exige un owner_grant válido con scope `lease:renew` (el queue_lease NO puede auto-renovarse).
   * - No puede reactivar un lease revocado.
   * - No puede ampliar scopes ni cambiar workspace_id / owner_id.
   * - No puede extender expires_at más allá de absolute_deadline.
   */
  public renewQueueLease(
    ownerGrant: OwnerGrant,
    params: {
      lease_id: string;
      additionalTtlSeconds: number;
      requestedScopes?: QueueLeaseScope[];
    },
  ): QueueLeaseRecord {
    const { owner_id } = this.consumeOwnerGrant(ownerGrant, "lease:renew");
    if (!Number.isFinite(params.additionalTtlSeconds) || params.additionalTtlSeconds <= 0) {
      throw new Error("DENY: invalid_renewal_ttl");
    }

    const tx = this.db.transaction(() => {
      const row = this.db
        .query("SELECT * FROM leases WHERE lease_id = ?")
        .get(params.lease_id) as any;
      if (!row) {
        throw new Error("DENY: lease_not_found");
      }
      if (row.owner_id !== owner_id) {
        throw new Error("DENY: lease_owner_mismatch");
      }
      if (row.revoked_at !== null) {
        throw new Error("DENY: cannot_renew_revoked_lease");
      }
      const now = this.nowFn();
      if (now >= row.absolute_deadline) {
        throw new Error("DENY: lease_absolute_deadline_reached");
      }
      const currentScopes: QueueLeaseScope[] = JSON.parse(row.scopes_json);
      if (params.requestedScopes) {
        for (const reqScope of params.requestedScopes) {
          if (!currentScopes.includes(reqScope)) {
            throw new Error("DENY: renewal_scope_escalation_forbidden");
          }
        }
      }
      const candidateExpiry = now + params.additionalTtlSeconds * 1000;
      if (candidateExpiry > row.absolute_deadline) {
        throw new Error("DENY: renewal_exceeds_absolute_deadline");
      }
      const nextGeneration = Number(row.generation) + 1;
      const finalScopes = params.requestedScopes ?? currentScopes;

      this.db
        .query(
          "UPDATE leases SET expires_at = ?, generation = ?, scopes_json = ? WHERE lease_id = ?",
        )
        .run(candidateExpiry, nextGeneration, JSON.stringify(finalScopes), params.lease_id);

      return this.mapLeaseRow({
        ...row,
        expires_at: candidateExpiry,
        generation: nextGeneration,
        scopes_json: JSON.stringify(finalScopes),
      });
    });

    return tx.immediate();
  }

  /**
   * Revoca transaccionalmente un queue_lease de forma inmediata.
   * También suspende cualquier tarea que aún no haya iniciado ejecución (QUEUED, AWAITING_APPROVAL, READY).
   */
  public revokeQueueLease(ownerGrant: OwnerGrant, lease_id: string): QueueLeaseRecord {
    const { owner_id } = this.consumeOwnerGrant(ownerGrant, "lease:revoke");
    const tx = this.db.transaction(() => {
      const row = this.db.query("SELECT * FROM leases WHERE lease_id = ?").get(lease_id) as any;
      if (!row) {
        throw new Error("DENY: lease_not_found");
      }
      if (row.owner_id !== owner_id) {
        throw new Error("DENY: lease_owner_mismatch");
      }
      const now = this.nowFn();
      const revokedAt = row.revoked_at ?? now;
      const nextGen = Number(row.generation) + 1;
      this.db
        .query("UPDATE leases SET revoked_at = ?, generation = ? WHERE lease_id = ?")
        .run(revokedAt, nextGen, lease_id);

      // Cualquier tarea encolada con este lease que aún no haya sido reclamada/ejecutada se cancela/suspende.
      this.db
        .query(
          `UPDATE tasks
           SET state = 'CANCELLED', reason = 'lease_revoked_before_execution', updated_at = ?
           WHERE lease_id = ? AND state IN ('QUEUED', 'AWAITING_APPROVAL', 'READY')`,
        )
        .run(now, lease_id);

      return this.mapLeaseRow({
        ...row,
        revoked_at: revokedAt,
        generation: nextGen,
      });
    });
    return tx.immediate();
  }

  /**
   * Verifica un token de queue_lease contra el registro autoritativo (fail-closed).
   */
  public verifyQueueLeaseToken(
    token: string,
    requiredScope: QueueLeaseScope,
  ): QueueLeaseRecord {
    if (!token || typeof token !== "string") {
      throw new Error("DENY: lease_token_missing");
    }
    let rows: any[];
    try {
      rows = this.db.query("SELECT * FROM leases").all() as any[];
    } catch {
      throw new Error("DENY: lease_registry_unavailable_fail_closed");
    }

    const candidateHash = sha256Hex(token);
    let matchedRow: any = null;
    for (const row of rows) {
      if (typeof row.token_hash === "string" && safeEqualHex(row.token_hash, candidateHash)) {
        matchedRow = row;
        break;
      }
    }
    if (!matchedRow) {
      throw new Error("DENY: lease_token_unknown");
    }

    const record = this.mapLeaseRow(matchedRow);
    const now = this.nowFn();
    if (record.revoked_at !== null) {
      throw new Error("DENY: lease_revoked");
    }
    if (now >= record.expires_at) {
      throw new Error("DENY: lease_expired");
    }
    if (now >= record.absolute_deadline) {
      throw new Error("DENY: lease_absolute_deadline_expired");
    }
    if (!record.scopes.includes(requiredScope)) {
      throw new Error(`DENY: lease_missing_scope:${requiredScope}`);
    }
    return record;
  }

  /**
   * Regla cardinal GOAL002-01 / A01: un queue_lease jamás puede autorizar ejecución.
   */
  public authorizeExecutionWithCredential(credential: { kind?: string } | string): never {
    if (typeof credential === "string" || credential?.kind === "queue_lease") {
      throw new Error("DENY: queue_lease_cannot_execute");
    }
    throw new Error("DENY: execution_requires_worker_lease_and_task_grant");
  }

  /**
   * Crea un TaskGrant pre-aprobado por el propietario para un workspace y conjunto de acciones.
   */
  public createTaskGrant(
    ownerGrant: OwnerGrant,
    params: {
      workspace_id: string;
      allowed_kinds: string[];
      allowed_actions: string[];
      max_runtime_ms?: number;
      ttlSeconds?: number;
    },
  ): TaskGrantRecord {
    const { owner_id } = this.consumeOwnerGrant(ownerGrant, "task:grant");
    const ws = this.db
      .query("SELECT workspace_id, owner_id FROM workspaces WHERE workspace_id = ?")
      .get(params.workspace_id) as { workspace_id: string; owner_id: string } | null;
    if (!ws || ws.owner_id !== owner_id) {
      throw new Error("DENY: workspace_not_found_or_unauthorized");
    }
    if (!params.allowed_kinds.length || !params.allowed_actions.length) {
      throw new Error("DENY: task_grant_requires_kinds_and_actions");
    }
    for (const k of params.allowed_kinds) {
      if (!ALLOWED_TASK_KINDS.has(k)) {
        throw new Error(`DENY: unsupported_task_kind:${k}`);
      }
    }
    for (const a of params.allowed_actions) {
      if (!SAFE_ACTION_RE.test(a) || a.startsWith("shell:") || a.startsWith("exec:")) {
        throw new Error(`DENY: forbidden_action_in_grant:${a}`);
      }
    }
    const now = this.nowFn();
    const ttlSeconds = params.ttlSeconds ?? 86400;
    const expires_at = now + ttlSeconds * 1000;
    const grant_id = `tg-${randomBytes(8).toString("hex")}`;
    const max_runtime_ms = params.max_runtime_ms ?? 30_000;

    this.db
      .query(
        `INSERT INTO task_grants (
          grant_id, owner_id, workspace_id, allowed_kinds_json,
          allowed_actions_json, max_runtime_ms, created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        grant_id,
        owner_id,
        params.workspace_id,
        JSON.stringify(params.allowed_kinds),
        JSON.stringify(params.allowed_actions),
        max_runtime_ms,
        now,
        expires_at,
      );

    return {
      grant_id,
      owner_id,
      workspace_id: params.workspace_id,
      allowed_kinds: [...params.allowed_kinds],
      allowed_actions: [...params.allowed_actions],
      max_runtime_ms,
      created_at: now,
      expires_at,
      revoked_at: null,
    };
  }

  /**
   * Revoca transaccionalmente un TaskGrant y cancela cualquier tarea READY asociada que aún no haya comenzado.
   */
  public revokeTaskGrant(ownerGrant: OwnerGrant, grant_id: string): TaskGrantRecord {
    const { owner_id } = this.consumeOwnerGrant(ownerGrant, "task:revoke");
    const tx = this.db.transaction((): TaskGrantRecord => {
      const row = this.db
        .query("SELECT * FROM task_grants WHERE grant_id = ?")
        .get(grant_id) as any;
      if (!row) {
        throw new Error("DENY: task_grant_not_found");
      }
      if (row.owner_id !== owner_id) {
        throw new Error("DENY: task_grant_owner_mismatch");
      }
      const now = this.nowFn();
      const revokedAt = row.revoked_at ?? now;
      this.db
        .query("UPDATE task_grants SET revoked_at = ? WHERE grant_id = ?")
        .run(revokedAt, grant_id);

      this.db
        .query(
          `UPDATE tasks
           SET state = 'CANCELLED', reason = 'task_grant_revoked_before_execution', updated_at = ?
           WHERE grant_id = ? AND state IN ('QUEUED', 'AWAITING_APPROVAL', 'READY')`,
        )
        .run(now, grant_id);

      return {
        grant_id: String(row.grant_id),
        owner_id: String(row.owner_id),
        workspace_id: String(row.workspace_id),
        allowed_kinds: JSON.parse(String(row.allowed_kinds_json)) as string[],
        allowed_actions: JSON.parse(String(row.allowed_actions_json)) as string[],
        max_runtime_ms: Number(row.max_runtime_ms),
        created_at: Number(row.created_at),
        expires_at: Number(row.expires_at),
        revoked_at: Number(revokedAt),
      };
    });
    return tx.immediate();
  }

  /**
   * Autoriza explícitamente una tarea en estado AWAITING_APPROVAL vinculándola a un TaskGrant válido (C04).
   */
  public authorizePendingTask(
    ownerGrant: OwnerGrant,
    params: { task_id: string; grant_id: string },
  ): TaskRecord {
    const { owner_id } = this.consumeOwnerGrant(ownerGrant, "task:grant");
    const now = this.nowFn();
    const tx = this.db.transaction((): TaskRecord => {
      const taskRow = this.db
        .query("SELECT * FROM tasks WHERE task_id = ?")
        .get(params.task_id) as any;
      if (!taskRow) {
        throw new Error("DENY: task_not_found");
      }
      if (taskRow.state !== "AWAITING_APPROVAL") {
        throw new Error(`DENY: task_not_awaiting_approval:${taskRow.state}`);
      }
      const leaseRow = this.db
        .query("SELECT * FROM leases WHERE lease_id = ?")
        .get(taskRow.lease_id) as any;
      if (!leaseRow || leaseRow.revoked_at !== null) {
        throw new Error("DENY: cannot_authorize_task_from_revoked_lease");
      }
      const grantRow = this.db
        .query("SELECT * FROM task_grants WHERE grant_id = ?")
        .get(params.grant_id) as any;
      if (
        !grantRow ||
        grantRow.owner_id !== owner_id ||
        grantRow.workspace_id !== taskRow.workspace_id ||
        grantRow.revoked_at !== null ||
        now >= Number(grantRow.expires_at)
      ) {
        throw new Error("DENY: invalid_or_expired_task_grant");
      }
      const allowedKinds: string[] = JSON.parse(grantRow.allowed_kinds_json);
      const allowedActions: string[] = JSON.parse(grantRow.allowed_actions_json);
      const requestedActions: string[] = JSON.parse(taskRow.requested_actions_json);
      if (
        !allowedKinds.includes(String(taskRow.kind)) ||
        !requestedActions.every((a) => allowedActions.includes(a))
      ) {
        throw new Error("DENY: task_grant_does_not_cover_task_actions");
      }

      this.db
        .query(
          "UPDATE tasks SET state = 'READY', reason = 'authorized_by_independent_task_grant', grant_id = ?, updated_at = ? WHERE task_id = ?",
        )
        .run(params.grant_id, now, params.task_id);

      const updated = this.db
        .query("SELECT * FROM tasks WHERE task_id = ?")
        .get(params.task_id) as any;
      return mapTaskRow(updated);
    });
    return tx.immediate();
  }

  private mapLeaseRow(row: any): QueueLeaseRecord {
    return {
      kind: "queue_lease",
      lease_id: String(row.lease_id),
      fp: String(row.fp),
      generation: Number(row.generation),
      owner_id: String(row.owner_id),
      workspace_id: String(row.workspace_id),
      scopes: JSON.parse(String(row.scopes_json)) as QueueLeaseScope[],
      audience: "isymcp-queue",
      policy_version: Number(row.policy_version),
      created_at: Number(row.created_at),
      expires_at: Number(row.expires_at),
      absolute_deadline: Number(row.absolute_deadline),
      revoked_at: row.revoked_at !== null && row.revoked_at !== undefined ? Number(row.revoked_at) : null,
    };
  }
}

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

      this.db
        .query(
          `INSERT INTO tasks (
            task_id, operation_id, idempotency_key, goal_id, conversation_ref,
            lease_id, workspace_id, kind, description, requested_actions_json,
            target_relpath, idempotent, state, reason, grant_id, worker_lease_id,
            attempt_count, created_at, updated_at, result_json, receipt_hmac
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, NULL, NULL)`,
        )
        .run(
          task_id,
          submission.operation_id,
          submission.idempotency_key,
          submission.goal_id,
          submission.conversation_ref,
          lease.lease_id,
          lease.workspace_id,
          task.kind,
          task.description,
          JSON.stringify(task.requested_actions),
          task.target_relpath ?? null,
          idempotentFlag,
          initialState,
          reason,
          matchedGrantId,
          now,
          now,
        );

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

    this.db
      .query(
        `INSERT INTO tasks (
          task_id, operation_id, idempotency_key, goal_id, conversation_ref,
          lease_id, workspace_id, kind, description, requested_actions_json,
          target_relpath, idempotent, state, reason, grant_id, worker_lease_id,
          attempt_count, created_at, updated_at, result_json, receipt_hmac
        ) VALUES (?, ?, ?, 'goal-alerts', 'ref-system-alerts', ?, ?, 'system_alert', ?, ?, NULL, 1, 'SUCCEEDED', 'system_alert_notification', NULL, NULL, 1, ?, ?, ?, NULL)`,
      )
      .run(
        taskId,
        operationId,
        idempotencyKey,
        leaseId,
        wsId,
        description,
        JSON.stringify([actionPayload]),
        now,
        now,
        JSON.stringify(resultObj),
      );

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
          artifact_hash: `sha256:${sha256Hex(`${task.task_id}:${task.operation_id}:ok`)}`,
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

/**
 * Adaptador de Transporte Remoto Autenticado de ISyMCP (HTTP Loopback + MCP Tool Dispatcher).
 * - Permite que un turno remoto con un `queue_lease` válido encole tareas (`POST /isymcp/monitor/submit`
 *   o tool `monitor_queue_submit`) y consulte estados (`GET /isymcp/monitor/status/:taskId` o tool `monitor_queue_status`).
 * - Rechaza de forma determinista cualquier intento de usar el transporte o un `queue_lease` para
 *   invocar herramientas de ejecución (`codex_exec`, `codex_apply_patch`, `POST /isymcp/monitor/exec`).
 */
export class MonitorRemoteTransport {
  private readonly queue: QueueService;
  private readonly authority: LeaseAuthority;

  constructor(queue: QueueService, authority: LeaseAuthority) {
    this.queue = queue;
    this.authority = authority;
  }

  /**
   * Despacha llamadas de herramientas MCP expuestas al conector remoto.
   */
  public dispatchMcpTool(
    toolName: string,
    args: Record<string, unknown>,
  ): { isError: boolean; payload: unknown } {
    if (
      toolName === "codex_exec" ||
      toolName === "codex_apply_patch" ||
      toolName === "codex_write_stdin" ||
      toolName === "codex_view_image" ||
      toolName === "exec_command" ||
      toolName === "apply_patch" ||
      toolName === "write_stdin" ||
      toolName === "view_image" ||
      toolName === "monitor_exec"
    ) {
      return {
        isError: true,
        payload: {
          accepted: false,
          state: "DENIED",
          reason: "DENY: queue_lease_cannot_execute",
        },
      };
    }

    if (toolName === "monitor_queue_submit") {
      const submission = args as unknown as QueueTaskSubmission;
      const res = this.queue.submitTask(submission);
      return {
        isError: !res.accepted,
        payload: res,
      };
    }

    if (toolName === "monitor_queue_status") {
      try {
        const leaseToken = String(args.lease_token ?? "");
        const taskId = String(args.task_id ?? "");
        const rec = this.queue.getTaskStatus(leaseToken, taskId);
        return {
          isError: false,
          payload: {
            task_id: rec.task_id,
            operation_id: rec.operation_id,
            state: rec.state,
            reason: rec.reason,
            attempt_count: rec.attempt_count,
            result: rec.result,
          },
        };
      } catch (err: any) {
        return {
          isError: true,
          payload: {
            accepted: false,
            state: "DENIED",
            reason: String(err?.message ?? err),
          },
        };
      }
    }

    return {
      isError: true,
      payload: {
        accepted: false,
        state: "DENIED",
        reason: `DENY: unknown_monitor_tool:${toolName}`,
      },
    };
  }

  /**
   * Manejador HTTP autenticado por Bearer token (`queue_lease`) para el bridge local.
   */
  public async handleHttpRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/ready") {
      return Response.json({ ok: true, service: "isymcp-remote-monitor", pid: process.pid }, { status: 200 });
    }
    const authHeader = req.headers.get("authorization") ?? "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

    if (url.pathname === "/isymcp/monitor/exec") {
      return Response.json(
        {
          accepted: false,
          state: "DENIED",
          reason: "DENY: queue_lease_cannot_execute",
        },
        { status: 403 },
      );
    }

    if (req.method === "POST" && (url.pathname === "/isymcp/monitor/alert" || url.pathname === "/isymcp/monitor/webhook/github")) {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { accepted: false, state: "DENIED", reason: "invalid_json_body" },
          { status: 400 },
        );
      }

      if (url.pathname === "/isymcp/monitor/webhook/github") {
        const ghEvent = req.headers.get("x-github-event") || "workflow_run";
        const workflowRun = (body.workflow_run || body) as Record<string, any>;
        const repoName = (body.repository as any)?.full_name || "repository";
        const workflowName = workflowRun.name || "CI";
        const conclusion = workflowRun.conclusion || workflowRun.status || "completed";
        const branch = workflowRun.head_branch || "main";
        const runId = workflowRun.id || "unknown";
        const htmlUrl = workflowRun.html_url || "";

        const alertRes = this.queue.submitAlertTask({
          source: "github",
          event: ghEvent,
          title: `GitHub CI [${repoName}]`,
          summary: `Workflow '${workflowName}' #${runId} on ${branch} finished: ${conclusion}`,
          metadata: { repo: repoName, workflow: workflowName, run_id: runId, conclusion, branch, url: htmlUrl },
        });
        return Response.json(alertRes, { status: 200 });
      }

      const alertRes = this.queue.submitAlertTask({
        source: typeof body.source === "string" ? body.source : "system",
        event: typeof body.event === "string" ? body.event : "alert",
        title: typeof body.title === "string" ? body.title : "Notificación del Monitor",
        summary: typeof body.summary === "string" ? body.summary : String(body.message || ""),
        metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {},
      });
      return Response.json(alertRes, { status: 200 });
    }

    if (req.method === "POST" && url.pathname === "/isymcp/monitor/submit") {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { accepted: false, state: "DENIED", reason: "invalid_json_body" },
          { status: 400 },
        );
      }
      const submission: QueueTaskSubmission = {
        ...(body as unknown as QueueTaskSubmission),
        lease_token: bearerToken || String(body.lease_token ?? ""),
      };
      const res = this.queue.submitTask(submission);
      return Response.json(res, { status: res.accepted ? 200 : 403 });
    }

    if (req.method === "GET" && url.pathname.startsWith("/isymcp/monitor/status/")) {
      const taskId = url.pathname.slice("/isymcp/monitor/status/".length).trim();
      try {
        const rec = this.queue.getTaskStatus(bearerToken, taskId);
        return Response.json(
          {
            task_id: rec.task_id,
            operation_id: rec.operation_id,
            state: rec.state,
            reason: rec.reason,
            attempt_count: rec.attempt_count,
            result: rec.result,
          },
          { status: 200 },
        );
      } catch (err: any) {
        return Response.json(
          {
            accepted: false,
            state: "DENIED",
            reason: String(err?.message ?? err),
          },
          { status: 403 },
        );
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  /**
   * Inicia un servidor HTTP en loopback (127.0.0.1) para pruebas E2E o ejecución del bridge local.
   */
  public startLoopbackServer(port = 0) {
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (req) => this.handleHttpRequest(req),
    });
  }
}

export function isQueueLeaseToken(token: unknown): token is string {
  return typeof token === "string" && token.startsWith("ql_") && token.length >= 20;
}

function loadOrCreateMonitorSecret(
  homeDir: string,
  filename: string,
  envOverride?: string,
): string {
  if (envOverride && envOverride.trim().length >= 16) {
    return envOverride.trim();
  }
  const secretsDir = join(homeDir, "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const secretPath = join(secretsDir, filename);
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const generated = `ms_${randomBytes(32).toString("hex")}`;
  writeFileSync(secretPath, `${generated}\n`, { mode: 0o600 });
  return generated;
}

/**
 * Abre la pila compartida del monitor sobre ~/.codex-web-http/remote-monitor.sqlite
 * (o las variables de entorno configuradas para tests de integración con el servidor MCP stdio).
 */
export function openBridgeMonitorStack(env: Record<string, string | undefined> = process.env) {
  const home = bridgeHome(env);
  mkdirSync(home, { recursive: true });
  const dbPath = env.CODEX_WEB_HTTP_MONITOR_DB?.trim() || join(home, "remote-monitor.sqlite");
  const ownerSecret = loadOrCreateMonitorSecret(
    home,
    "monitor-owner.key",
    env.CODEX_WEB_HTTP_MONITOR_OWNER_SECRET,
  );
  const workerSecret = loadOrCreateMonitorSecret(
    home,
    "monitor-worker.key",
    env.CODEX_WEB_HTTP_MONITOR_WORKER_SECRET,
  );
  const db = openMonitorDatabase(dbPath);
  const authority = new LeaseAuthority(db, { ownerSecret });
  const queue = new QueueService(db, authority);
  const worker = new WorkerAdapter({ workerSecret, db });
  const monitor = new MonitorCoordinator(db, worker);
  const transport = new MonitorRemoteTransport(queue, authority);
  return { db, dbPath, authority, queue, worker, monitor, transport, workerSecret, env };
}

/**
 * Maneja una invocación del servidor MCP (`src/mcp/main.ts`) cuando `turn_token` es un `QueueLease` (`ql_...`).
 * Garantiza que un `QueueLease` jamás pueda ejecutar comandos (`codex_exec` / `codex_apply_patch` -> DENY)
 * y que solo permita descubrir y usar `monitor_queue_submit` y `monitor_queue_status`.
 */
export function handleQueueLeaseMcpCall(
  tool: string,
  token: string,
  input: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): { isError: boolean; payload: Record<string, unknown> } {
  const { db, authority, transport } = openBridgeMonitorStack(env);
  try {
    if (
      tool === "codex_exec" ||
      tool === "codex_apply_patch" ||
      tool === "codex_write_stdin" ||
      tool === "codex_view_image"
    ) {
      return {
        isError: true,
        payload: {
          error: "DENY: queue_lease_cannot_execute",
          reason: "DENY: queue_lease_cannot_execute",
          authority: "queue_lease",
          accepted: false,
          state: "DENIED",
        },
      };
    }

    const verifyAnyScope = (): QueueLeaseRecord => {
      try {
        return authority.verifyQueueLeaseToken(token, "queue:submit");
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (msg.includes("lease_missing_scope")) {
          return authority.verifyQueueLeaseToken(token, "queue:status");
        }
        throw err;
      }
    };

    if (tool === "codex_turn_start") {
      try {
        const lease = verifyAnyScope();
        return {
          isError: false,
          payload: {
            started: true,
            authority: "queue_lease",
            lease_id: lease.lease_id,
            workspace_id: lease.workspace_id,
            scopes: lease.scopes,
            execution_allowed: false,
          },
        };
      } catch (err: any) {
        return {
          isError: true,
          payload: {
            error: String(err?.message ?? err),
            reason: String(err?.message ?? err),
            accepted: false,
            state: "DENIED",
          },
        };
      }
    }

    if (tool === "codex_tool_inventory") {
      try {
        const lease = verifyAnyScope();
        const tools = [];
        if (lease.scopes.includes("queue:submit")) {
          tools.push({
            wire_name: "monitor_queue_submit",
            name: "monitor_queue_submit",
            description:
              "Enqueue a structured task request in the local ISyMCP Remote Task Monitor (execution_started=false).",
            inputSchema: {
              type: "object",
              required: [
                "schema_version",
                "operation_id",
                "goal_id",
                "conversation_ref",
                "task",
                "idempotency_key",
                "requested_at",
              ],
              properties: {
                schema_version: { type: "number", const: 1 },
                operation_id: { type: "string" },
                goal_id: { type: "string" },
                conversation_ref: { type: "string" },
                task: {
                  type: "object",
                  required: ["kind", "workspace_id", "description", "requested_actions"],
                  properties: {
                    kind: { type: "string" },
                    workspace_id: { type: "string" },
                    description: { type: "string" },
                    requested_actions: { type: "array", items: { type: "string" } },
                    target_relpath: { type: "string" },
                    idempotent: { type: "boolean" },
                  },
                },
                idempotency_key: { type: "string" },
                requested_at: { type: "string" },
              },
            },
          });
        }
        if (lease.scopes.includes("queue:status")) {
          tools.push({
            wire_name: "monitor_queue_status",
            name: "monitor_queue_status",
            description:
              "Query status and verifiable receipt of a task in the local ISyMCP Remote Task Monitor.",
            inputSchema: {
              type: "object",
              required: ["task_id"],
              properties: {
                task_id: { type: "string" },
              },
            },
          });
        }
        return {
          isError: false,
          payload: {
            tools,
            authority: "queue_lease",
            lease_id: lease.lease_id,
            workspace_id: lease.workspace_id,
            scopes: lease.scopes,
            execution_allowed: false,
          },
        };
      } catch (err: any) {
        return {
          isError: true,
          payload: {
            error: String(err?.message ?? err),
            reason: String(err?.message ?? err),
            tools: [],
            accepted: false,
            state: "DENIED",
          },
        };
      }
    }

    if (tool === "codex_tool_call") {
      const wireName = String(input.wire_name ?? "");
      const rawArgs =
        typeof input.arguments === "object" && input.arguments !== null
          ? (input.arguments as Record<string, unknown>)
          : {};
      const res = transport.dispatchMcpTool(wireName, {
        ...rawArgs,
        lease_token: token,
      });
      const payloadObj =
        typeof res.payload === "object" && res.payload !== null
          ? (res.payload as Record<string, unknown>)
          : { result: res.payload };
      if (res.isError) {
        return {
          isError: true,
          payload: {
            error: String(payloadObj.reason ?? "DENY"),
            ...payloadObj,
          },
        };
      }
      return {
        isError: false,
        payload: payloadObj,
      };
    }

    if (tool === "codex_turn_complete") {
      try {
        const lease = verifyAnyScope();
        return {
          isError: false,
          payload: {
            completed: true,
            authority: "queue_lease",
            lease_id: lease.lease_id,
          },
        };
      } catch (err: any) {
        return {
          isError: true,
          payload: {
            error: String(err?.message ?? err),
            reason: String(err?.message ?? err),
            accepted: false,
            state: "DENIED",
          },
        };
      }
    }

    return {
      isError: true,
      payload: {
        error: `DENY: unsupported_tool_for_queue_lease:${tool}`,
        accepted: false,
        state: "DENIED",
      },
    };
  } finally {
    db.close();
  }
}
