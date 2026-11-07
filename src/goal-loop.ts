// src/goal-loop.ts — Coordinador determinista para loops de revisión autónoma (GOAL-001).
//
// Implementa la arquitectura acordada entre Danny, ChatGPT (revisor/planificador)
// y Gemini (ejecutor local) sobre ISyMCP:
//   - Contrato inmutable (goal_hash) fuera de la autoridad de los modelos.
//   - Verificación independiente ejecutada por el coordinador (no por el ejecutor).
//   - Exclusión mutua multi-proceso mediante lockfile atómico (O_CREAT | O_EXCL) + fsyncSync + renameSync.
//   - Validación estructural e integridad (HMAC opcional) del archivo de estado persistido.
//   - Allowlist de operaciones completas (subcomandos, flags y rutas confinadas), no solo nombres de binarios.
//   - Verificación de cobertura completa de acceptance_criteria antes de permitir PASS o DONE.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveWithinReal } from "./codex-sessions";

export type CoordinatorDecision = "CONTINUE" | "PAUSE" | "DENY" | "DONE";

export interface GoalSpec {
  goal_id: string;
  description: string;
  max_iterations: number;
  allowed_cwd: string;
  allow_destructive: boolean;
  acceptance_criteria: string[];
  verification_command: string[];
}

export interface GoalContract extends GoalSpec {
  goal_hash: string;
}

export interface IndependentVerificationResult {
  passed: boolean;
  exit_code: number;
  output_summary: string;
  artifact_hash: string;
}

export interface EvidencePacket {
  goal_id: string;
  iteration: number;
  operation_id: string;
  goal_hash: string;
  repo: {
    base_sha: string;
    head_sha: string;
    dirty: boolean;
  };
  execution: {
    commands: string[];
    exit_codes: number[];
  };
  evidence: {
    demonstrated: string[];
    inferred: string[];
    not_demonstrated: string[];
  };
  executor_claim: "PASS" | "IN_PROGRESS" | "BLOCKED";
  independent_verification: IndependentVerificationResult;
  status: "REVIEW_REQUIRED" | "VERIFIED" | "FAILED";
}

export interface ReviewerProposal {
  goal_id: string;
  reviewed_iteration: number;
  operation_id: string;
  decision: CoordinatorDecision;
  rationale: string;
  preconditions: string[];
  reviewed_packet_hash?: string;
  next_experiment?: {
    command?: string[];
    target_cwd?: string;
    description: string;
    override_goal_hash?: string;
  };
}

export interface CoordinatorVerdict {
  decision: CoordinatorDecision;
  reason: string;
  iteration: number;
  packet_hash?: string;
  authorized_command?: string[];
}

export interface CoordinatorOptions {
  /** Ruta opcional para persistir el estado atómicamente con lock multi-proceso. */
  statePath?: string;
  /** Secreto opcional para autenticar (HMAC-SHA256) el estado persistido en disco. */
  stateSecret?: string;
  /**
   * Runner de verificación independiente controlado por el coordinador (nunca por el ejecutor).
   */
  verifier?: (contract: GoalContract) => IndependentVerificationResult;
}

interface PersistedCoordinatorState {
  goal_hash: string;
  currentIteration: number;
  seenOperations: string[];
  history: EvidencePacket[];
  hmac?: string;
}

const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

const FORBIDDEN_FLAGS_RE =
  /^(-c|-e|--eval|--preload|-r|--require|--import|--env-file|--config|--git-dir|--work-tree|--exec-path|--upload-pack|--receive-pack|--project|-p|--outDir|--outFile|--tsBuildInfoFile)(\b|=)/i;

const SAFE_GIT_READONLY_SUBCOMMANDS = new Set(["status", "diff", "log", "rev-parse", "show"]);

export function computeGoalHash(spec: GoalSpec): string {
  const canonical = JSON.stringify({
    goal_id: spec.goal_id,
    description: spec.description,
    max_iterations: spec.max_iterations,
    allowed_cwd: spec.allowed_cwd,
    allow_destructive: spec.allow_destructive,
    acceptance_criteria: [...spec.acceptance_criteria],
    verification_command: [...spec.verification_command],
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function computePacketHash(packet: EvidencePacket): string {
  const canonical = JSON.stringify({
    goal_id: packet.goal_id,
    iteration: packet.iteration,
    operation_id: packet.operation_id,
    goal_hash: packet.goal_hash,
    repo: packet.repo,
    execution: packet.execution,
    evidence: packet.evidence,
    executor_claim: packet.executor_claim,
    independent_verification: packet.independent_verification,
    status: packet.status,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function createGoalContract(spec: GoalSpec): GoalContract {
  return {
    ...spec,
    acceptance_criteria: [...spec.acceptance_criteria],
    verification_command: [...spec.verification_command],
    goal_hash: computeGoalHash(spec),
  };
}

/**
 * Ejecuta el comando de verificación independiente definido en el contrato directamente desde el coordinador.
 */
export function runContractVerification(
  contract: GoalContract,
  artifactPaths: string[] = [],
): IndependentVerificationResult {
  const proc = Bun.spawnSync(contract.verification_command, {
    cwd: contract.allowed_cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const exitCode = proc.exitCode ?? 1;
  const rawOut = (proc.stdout.toString() + "\n" + proc.stderr.toString()).trim();
  const hash = createHash("sha256");
  for (const rel of [...artifactPaths].sort()) {
    const resolved = resolveWithinReal(contract.allowed_cwd, rel);
    if (resolved && existsSync(resolved)) {
      hash.update(rel, "utf8");
      hash.update(readFileSync(resolved));
    }
  }
  return {
    passed: exitCode === 0,
    exit_code: exitCode,
    output_summary: rawOut.slice(0, 500),
    artifact_hash: `sha256:${hash.digest("hex")}`,
  };
}

/**
 * Valida la operación completa (binario + subcomando + flags + confinamiento de argumentos de ruta),
 * rechazando subcomandos arbitrarios, hooks, scripts, instalaciones o configuraciones externas.
 */
export function isOperationAllowed(cmd: string[], contract: GoalContract): boolean {
  if (!Array.isArray(cmd) || cmd.length === 0) return false;
  if (cmd.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.includes("\0"))) {
    return false;
  }

  // Bloqueo global de flags peligrosos de evaluación, precarga, redirección de config o compilación fuera del árbol
  for (const arg of cmd.slice(1)) {
    if (FORBIDDEN_FLAGS_RE.test(arg.trim())) return false;
  }

  const bin = cmd[0].trim();

  // 1. tsc: únicamente `tsc --noEmit` exacto
  if (bin === "tsc") {
    return cmd.length === 2 && cmd[1] === "--noEmit";
  }

  // 2. bun: únicamente `bun run typecheck` o `bun test <archivos-dentro-del-workspace>`
  if (bin === "bun") {
    const sub = cmd[1];
    if (sub === "run") {
      return cmd.length === 3 && cmd[2] === "typecheck";
    }
    if (sub === "test") {
      for (let i = 2; i < cmd.length; i++) {
        const arg = cmd[i];
        if (arg === "--bail") continue;
        if (arg === "--timeout") {
          const next = cmd[i + 1];
          if (!next || !/^\d+$/.test(next)) return false;
          i++;
          continue;
        }
        if (arg.startsWith("-")) return false;
        // Cualquier argumento de ruta de test debe resolver dentro de allowed_cwd (sin escapar por symlink ni ..)
        const candidate = join(contract.allowed_cwd, arg);
        if (!resolveWithinReal(contract.allowed_cwd, candidate)) {
          return false;
        }
      }
      return true;
    }
    return false;
  }

  // 3. git: únicamente subcomandos de solo lectura sin overrides de configuración
  if (bin === "git") {
    const sub = cmd[1];
    if (!sub || !SAFE_GIT_READONLY_SUBCOMMANDS.has(sub)) return false;
    for (const arg of cmd.slice(2)) {
      if (arg.startsWith("-")) {
        // Solo permitir flags inocuos de formato en lectura
        if (!/^(--oneline|--stat|--decorate|--no-pager|-n\d*)$/.test(arg)) return false;
      } else {
        const candidate = join(contract.allowed_cwd, arg);
        if (!resolveWithinReal(contract.allowed_cwd, candidate)) return false;
      }
    }
    return true;
  }

  return false;
}

function allCriteriaDemonstrated(contract: GoalContract, packet: EvidencePacket): boolean {
  if (packet.evidence.not_demonstrated.length > 0) return false;
  const demSet = new Set(packet.evidence.demonstrated);
  return contract.acceptance_criteria.every((crit) => demSet.has(crit));
}

function progressSignature(packet: EvidencePacket): string {
  return JSON.stringify({
    head_sha: packet.repo.head_sha,
    exit_codes: packet.execution.exit_codes,
    demonstrated: [...packet.evidence.demonstrated].sort(),
    verified: packet.independent_verification.passed,
  });
}

function computeStateHmac(secret: string, state: Omit<PersistedCoordinatorState, "hmac">): string {
  const canonical = JSON.stringify({
    goal_hash: state.goal_hash,
    currentIteration: state.currentIteration,
    seenOperations: state.seenOperations,
    history: state.history,
  });
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

export class GoalCoordinator {
  readonly contract: GoalContract;
  private currentIteration = 0;
  private readonly seenOperations = new Set<string>();
  private readonly history: EvidencePacket[] = [];
  private readonly statePath?: string;
  private readonly stateSecret?: string;
  private readonly verifier?: (contract: GoalContract) => IndependentVerificationResult;

  constructor(contract: GoalContract, options: CoordinatorOptions = {}) {
    const expectedHash = computeGoalHash(contract);
    if (contract.goal_hash !== expectedHash) {
      throw new Error(`goal_contract_invalid_hash: esperado ${expectedHash}, recibido ${contract.goal_hash}`);
    }
    this.contract = Object.freeze({ ...contract });
    this.statePath = options.statePath;
    this.stateSecret = options.stateSecret;
    this.verifier = options.verifier;

    if (this.statePath && existsSync(this.statePath)) {
      this.loadAndValidateStateFromDisk();
    }
  }

  private withStateLock<T>(fn: () => T): T {
    if (!this.statePath) return fn();
    const lockPath = `${this.statePath}.lock`;
    const deadline = Date.now() + 3_000;
    let lockFd: number | null = null;
    while (lockFd === null) {
      try {
        lockFd = openSync(lockPath, "wx", 0o600);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST" || Date.now() >= deadline) {
          throw new Error(`goal_state_lock_timeout: no se pudo adquirir lock exclusivo ${lockPath}`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      if (existsSync(this.statePath)) {
        this.loadAndValidateStateFromDisk();
      }
      return fn();
    } finally {
      try {
        closeSync(lockFd);
      } catch {}
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }

  private loadAndValidateStateFromDisk(): void {
    if (!this.statePath) return;
    let raw: PersistedCoordinatorState;
    try {
      raw = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedCoordinatorState;
    } catch {
      throw new Error("goal_state_corrupted: JSON inválido en archivo de estado");
    }
    if (
      !raw ||
      typeof raw.goal_hash !== "string" ||
      typeof raw.currentIteration !== "number" ||
      !Array.isArray(raw.seenOperations) ||
      !Array.isArray(raw.history)
    ) {
      throw new Error("goal_state_corrupted: estructura de estado inválida");
    }
    if (raw.goal_hash !== this.contract.goal_hash) {
      throw new Error("goal_state_hash_mismatch: el estado persistido pertenece a otro contrato");
    }
    if (raw.currentIteration !== raw.history.length || raw.currentIteration > this.contract.max_iterations) {
      throw new Error("goal_state_corrupted: currentIteration inconsistente con el historial");
    }
    const opSet = new Set(raw.seenOperations);
    for (let i = 0; i < raw.history.length; i++) {
      const pkt = raw.history[i];
      if (!pkt || pkt.iteration !== i + 1 || pkt.goal_hash !== this.contract.goal_hash) {
        throw new Error("goal_state_corrupted: secuencia de historial alterada");
      }
      if (!opSet.has(pkt.operation_id)) {
        throw new Error("goal_state_corrupted: operation_id del historial ausente en seenOperations");
      }
    }
    if (this.stateSecret) {
      if (typeof raw.hmac !== "string" || !/^[0-9a-f]{64}$/i.test(raw.hmac)) {
        throw new Error("goal_state_corrupted: falta firma HMAC en el estado persistido");
      }
      const expectedHmac = computeStateHmac(this.stateSecret, {
        goal_hash: raw.goal_hash,
        currentIteration: raw.currentIteration,
        seenOperations: raw.seenOperations,
        history: raw.history,
      });
      const a = Buffer.from(raw.hmac, "hex");
      const b = Buffer.from(expectedHmac, "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new Error("goal_state_corrupted: firma HMAC inválida (estado adulterado en disco)");
      }
    }

    this.currentIteration = raw.currentIteration;
    this.seenOperations.clear();
    for (const op of raw.seenOperations) this.seenOperations.add(op);
    this.history.length = 0;
    for (const pkt of raw.history) this.history.push(pkt);
  }

  private persistState(): void {
    if (!this.statePath) return;
    const tmp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    const basePayload: Omit<PersistedCoordinatorState, "hmac"> = {
      goal_hash: this.contract.goal_hash,
      currentIteration: this.currentIteration,
      seenOperations: Array.from(this.seenOperations),
      history: this.history,
    };
    const payload: PersistedCoordinatorState = this.stateSecret
      ? { ...basePayload, hmac: computeStateHmac(this.stateSecret, basePayload) }
      : basePayload;

    const fd = openSync(tmp, "w", 0o600);
    try {
      const buf = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
      let offset = 0;
      while (offset < buf.length) {
        offset += require("node:fs").writeSync(fd, buf, offset, buf.length - offset);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.statePath);
  }

  get iteration(): number {
    return this.currentIteration;
  }

  get packets(): ReadonlyArray<EvidencePacket> {
    return this.history;
  }

  get latestPacketHash(): string | undefined {
    const latest = this.history[this.history.length - 1];
    return latest ? computePacketHash(latest) : undefined;
  }

  /**
   * Registra el paquete de evidencia de una iteración local del ejecutor (Gemini)
   * bajo lock exclusivo multi-proceso y evalúa invariantes antes de enviarlo al revisor.
   */
  recordIteration(packet: EvidencePacket): CoordinatorVerdict {
    return this.withStateLock(() => {
      if (packet.goal_id !== this.contract.goal_id) {
        return { decision: "DENY", reason: "goal_id_mismatch", iteration: this.currentIteration };
      }
      if (packet.goal_hash !== this.contract.goal_hash) {
        return { decision: "DENY", reason: "goal_mutation_forbidden", iteration: this.currentIteration };
      }
      if (!packet.operation_id || this.seenOperations.has(packet.operation_id)) {
        return { decision: "DENY", reason: "duplicate_operation_id", iteration: this.currentIteration };
      }
      if (!GIT_SHA_RE.test(packet.repo.base_sha) || !GIT_SHA_RE.test(packet.repo.head_sha)) {
        return { decision: "DENY", reason: "invalid_git_sha", iteration: this.currentIteration };
      }
      if (packet.iteration !== this.currentIteration + 1) {
        return { decision: "DENY", reason: "invalid_iteration_sequence", iteration: this.currentIteration };
      }
      if (packet.iteration > this.contract.max_iterations) {
        return { decision: "PAUSE", reason: "max_iterations_reached", iteration: this.currentIteration };
      }

      let effectivePacket = packet;
      if (this.verifier) {
        const verified = this.verifier(this.contract);
        if (packet.independent_verification.passed && !verified.passed) {
          this.seenOperations.add(packet.operation_id);
          this.currentIteration = packet.iteration;
          effectivePacket = { ...packet, independent_verification: verified, status: "FAILED" };
          this.history.push(effectivePacket);
          this.persistState();
          return {
            decision: "DENY",
            reason: "unverified_pass_claim",
            iteration: this.currentIteration,
            packet_hash: computePacketHash(effectivePacket),
          };
        }
        effectivePacket = { ...packet, independent_verification: verified };
      }

      // Falla 1: El ejecutor reclama PASS pero la verificación independiente falló o la evidencia no cubre todos los acceptance_criteria
      if (
        effectivePacket.executor_claim === "PASS" &&
        (!effectivePacket.independent_verification.passed ||
          !allCriteriaDemonstrated(this.contract, effectivePacket))
      ) {
        this.seenOperations.add(effectivePacket.operation_id);
        this.currentIteration = effectivePacket.iteration;
        this.history.push(effectivePacket);
        this.persistState();
        return {
          decision: "DENY",
          reason: "unverified_pass_claim",
          iteration: this.currentIteration,
          packet_hash: computePacketHash(effectivePacket),
        };
      }

      // Falla 5: Detección de estancamiento (2 iteraciones consecutivas sin progreso verificable)
      const prev = this.history[this.history.length - 1];
      if (
        prev &&
        !effectivePacket.independent_verification.passed &&
        progressSignature(prev) === progressSignature(effectivePacket)
      ) {
        this.seenOperations.add(effectivePacket.operation_id);
        this.currentIteration = effectivePacket.iteration;
        this.history.push(effectivePacket);
        this.persistState();
        return {
          decision: "PAUSE",
          reason: "stagnation_detected",
          iteration: this.currentIteration,
          packet_hash: computePacketHash(effectivePacket),
        };
      }

      this.seenOperations.add(effectivePacket.operation_id);
      this.currentIteration = effectivePacket.iteration;
      this.history.push(effectivePacket);
      this.persistState();

      return {
        decision: "CONTINUE",
        reason: "evidence_recorded_awaiting_review",
        iteration: this.currentIteration,
        packet_hash: computePacketHash(effectivePacket),
      };
    });
  }

  /**
   * Evalúa la propuesta devuelta por el revisor (ChatGPT) bajo lock exclusivo multi-proceso.
   */
  evaluateReviewerProposal(proposal: ReviewerProposal): CoordinatorVerdict {
    return this.withStateLock(() => {
      if (proposal.goal_id !== this.contract.goal_id) {
        return { decision: "DENY", reason: "goal_id_mismatch", iteration: this.currentIteration };
      }

      // Falla 3: Operación duplicada / reintento no reconciliado
      if (!proposal.operation_id || this.seenOperations.has(proposal.operation_id)) {
        return { decision: "DENY", reason: "duplicate_operation_id", iteration: this.currentIteration };
      }

      // Falla 2: Respuesta correspondiente a una iteración anterior o futura
      if (proposal.reviewed_iteration !== this.currentIteration) {
        return {
          decision: "DENY",
          reason: "stale_iteration_response",
          iteration: this.currentIteration,
        };
      }

      const latest = this.history[this.history.length - 1];
      if (!latest) {
        return { decision: "PAUSE", reason: "no_evidence_to_review", iteration: this.currentIteration };
      }

      // Falla 2b: goal_hash válido pero reviewed_packet_hash obsoleto o alterado
      const expectedPacketHash = computePacketHash(latest);
      if (proposal.reviewed_packet_hash && proposal.reviewed_packet_hash !== expectedPacketHash) {
        return {
          decision: "DENY",
          reason: "stale_iteration_response",
          iteration: this.currentIteration,
        };
      }

      // Intento de mutar el hash del objetivo (autoridad circular)
      if (
        proposal.next_experiment?.override_goal_hash &&
        proposal.next_experiment.override_goal_hash !== this.contract.goal_hash
      ) {
        return {
          decision: "DENY",
          reason: "goal_mutation_forbidden",
          iteration: this.currentIteration,
        };
      }

      // Falla 1 / Autoridad circular: GPT intenta declarar DONE sin verificación independiente o sin cubrir todos los criterios del contrato
      if (proposal.decision === "DONE") {
        if (!latest.independent_verification.passed || !allCriteriaDemonstrated(this.contract, latest)) {
          return {
            decision: "DENY",
            reason: "unverified_pass_claim",
            iteration: this.currentIteration,
          };
        }
        this.seenOperations.add(proposal.operation_id);
        this.persistState();
        return {
          decision: "DONE",
          reason: "all_criteria_demonstrated",
          iteration: this.currentIteration,
          packet_hash: expectedPacketHash,
        };
      }

      if (proposal.decision === "PAUSE" || proposal.decision === "DENY") {
        this.seenOperations.add(proposal.operation_id);
        this.persistState();
        return {
          decision: proposal.decision,
          reason: proposal.rationale || "reviewer_requested_stop",
          iteration: this.currentIteration,
          packet_hash: expectedPacketHash,
        };
      }

      if (this.currentIteration >= this.contract.max_iterations) {
        return {
          decision: "PAUSE",
          reason: "max_iterations_reached",
          iteration: this.currentIteration,
        };
      }

      const nextExp = proposal.next_experiment;
      if (nextExp) {
        // Falla 4a: Target CWD fuera del workspace autorizado (con resolución real de symlinks)
        if (nextExp.target_cwd) {
          const resolved = resolveWithinReal(this.contract.allowed_cwd, nextExp.target_cwd);
          if (!resolved) {
            return {
              decision: "DENY",
              reason: "out_of_scope_or_destructive",
              iteration: this.currentIteration,
            };
          }
        }

        // Falla 4b: Allowlist de operaciones completas (subcomandos, flags y rutas confinadas)
        if (nextExp.command && nextExp.command.length > 0) {
          if (!isOperationAllowed(nextExp.command, this.contract)) {
            return {
              decision: "DENY",
              reason: "out_of_scope_or_destructive",
              iteration: this.currentIteration,
            };
          }
        }
      }

      this.seenOperations.add(proposal.operation_id);
      this.persistState();
      return {
        decision: "CONTINUE",
        reason: "authorized_next_step",
        iteration: this.currentIteration,
        packet_hash: expectedPacketHash,
        authorized_command: nextExp?.command,
      };
    });
  }
}

/**
 * Construye el prompt estructurado para que el revisor (ChatGPT) evalúe un EvidencePacket
 * y devuelva exclusivamente un objeto JSON conforme a ReviewerProposal.
 */
export function formatReviewerPrompt(contract: GoalContract, packet: EvidencePacket): string {
  const pktHash = computePacketHash(packet);
  return [
    `[ISyMCP GOAL COORDINATOR — ${contract.goal_id} · ITERATION ${packet.iteration}/${contract.max_iterations}]`,
    `Actúas como Revisor Crítico dentro del runtime de coordinación gobernado por contratos.`,
    `Evalúa el siguiente paquete de evidencia canónica contra el contrato inmutable y responde con un bloque JSON \`\`\`json ... \`\`\` que siga exactamente la interfaz ReviewerProposal.`,
    ``,
    `### Contrato Inmutable (goal_hash: ${contract.goal_hash})`,
    "```json",
    JSON.stringify(contract, null, 2),
    "```",
    ``,
    `### Paquete de Evidencia Canónica (Iteración ${packet.iteration} · packet_hash: ${pktHash})`,
    "```json",
    JSON.stringify(packet, null, 2),
    "```",
    ``,
    `### Formato de Respuesta Requerido (JSON estricto):`,
    "```json",
    JSON.stringify(
      {
        goal_id: contract.goal_id,
        reviewed_iteration: packet.iteration,
        reviewed_packet_hash: pktHash,
        operation_id: `rev-${contract.goal_id.toLowerCase()}-it${packet.iteration}`,
        decision: "DONE | CONTINUE | PAUSE | DENY",
        rationale: "Justificación técnica concisa basada en la evidencia demostrada",
        preconditions: ["Invariantes verificadas"],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

/**
 * Extrae y valida el objeto ReviewerProposal desde la respuesta en texto o Markdown de ChatGPT.
 */
export function parseReviewerProposal(rawText: string): ReviewerProposal {
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : rawText.trim();
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error("reviewer_parse_error: no se encontró un objeto JSON en la respuesta del revisor");
  }
  const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as Partial<ReviewerProposal>;
  if (
    typeof parsed.goal_id !== "string" ||
    typeof parsed.reviewed_iteration !== "number" ||
    typeof parsed.operation_id !== "string" ||
    !["CONTINUE", "PAUSE", "DENY", "DONE"].includes(String(parsed.decision))
  ) {
    throw new Error("reviewer_schema_error: el JSON devuelto no cumple el contrato ReviewerProposal");
  }
  return {
    goal_id: parsed.goal_id,
    reviewed_iteration: parsed.reviewed_iteration,
    operation_id: parsed.operation_id,
    decision: parsed.decision as CoordinatorDecision,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    preconditions: Array.isArray(parsed.preconditions) ? parsed.preconditions.map(String) : [],
    ...(typeof parsed.reviewed_packet_hash === "string"
      ? { reviewed_packet_hash: parsed.reviewed_packet_hash }
      : {}),
    next_experiment: parsed.next_experiment,
  };
}
