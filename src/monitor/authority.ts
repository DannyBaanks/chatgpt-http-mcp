// src/monitor/authority.ts — LeaseAuthority: owner grants, queue leases, task grants y su revocación.
// (Movido sin cambios desde src/remote-monitor.ts, 2026-11-12.)
import { hmacHex, safeEqualHex, sha256Hex } from "../crypto";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { mapTaskRow } from "./db";
import { ALLOWED_TASK_KINDS, DEFAULT_LEASE_POLICY, LeasePolicyConfig, MintedQueueLease, OwnerGrant, OwnerGrantScope, QueueLeaseRecord, QueueLeaseScope, SAFE_ACTION_RE, SAFE_IDENTIFIER_RE, TaskGrantRecord, TaskRecord } from "./types";

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
