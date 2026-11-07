// src/goal-loop.ts — Coordinador determinista para loops de revisión autónoma (GOAL-001).
//
// Implementa la arquitectura acordada entre Danny, ChatGPT (revisor/planificador)
// y Gemini (ejecutor local) sobre ISyMCP:
//   - El objetivo y los criterios de aceptación viven en un contrato inmutable (goal_hash).
//   - La conversación NO es la fuente de verdad; cada iteración produce un EvidencePacket canónico.
//   - La verificación independiente la ejecuta el propio coordinador (no confía en el booleano del ejecutor).
//   - El estado (iteración, operation_ids vistos, historial) puede persistirse en disco de forma atómica.
//   - Valida formato real de SHA Git, resuelve symlinks con realpath y aplica allowlist de binarios.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  /** Ruta opcional para persistir el estado atómicamente entre reinicios. */
  statePath?: string;
  /**
   * Runner de verificación independiente controlado por el coordinador (nunca por el ejecutor).
   * Cuando se provee, el coordinador ejecuta este verificador y rechaza cualquier intento
   * del ejecutor de falsificar `independent_verification.passed = true`.
   */
  verifier?: (contract: GoalContract) => IndependentVerificationResult;
  /** Binarios permitidos para next_experiment.command (por defecto: bun, git, tsc). */
  allowedBinaries?: string[];
}

interface PersistedCoordinatorState {
  goal_hash: string;
  currentIteration: number;
  seenOperations: string[];
  history: EvidencePacket[];
}

const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const DEFAULT_ALLOWED_BINARIES = new Set(["bun", "git", "tsc"]);
const SHELL_OR_INTERPRETER_FLAGS = new Set(["-c", "-e", "--eval", "/c", "-command"]);

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-[a-zA-Z]*[rf]/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-zA-Z]*f/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+checkout\s+--\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
];

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

function isCommandAllowed(cmd: string[], allowedBinaries: Set<string>, allowDestructive: boolean): boolean {
  if (cmd.length === 0) return false;
  const bin = cmd[0].trim();
  // Prohibir rutas relativas/absolutas arbitrarias o shells; exigir binario en allowlist
  if (!allowedBinaries.has(bin)) return false;
  // Bloquear ejecución de código arbitrario inline (-e, -c, --eval)
  if (cmd.some((arg) => SHELL_OR_INTERPRETER_FLAGS.has(arg.trim().toLowerCase()))) {
    return false;
  }
  if (!allowDestructive) {
    const joined = cmd.join(" ");
    if (DESTRUCTIVE_PATTERNS.some((re) => re.test(joined))) return false;
  }
  return true;
}

function progressSignature(packet: EvidencePacket): string {
  return JSON.stringify({
    head_sha: packet.repo.head_sha,
    exit_codes: packet.execution.exit_codes,
    demonstrated: [...packet.evidence.demonstrated].sort(),
    verified: packet.independent_verification.passed,
  });
}

export class GoalCoordinator {
  readonly contract: GoalContract;
  private currentIteration = 0;
  private readonly seenOperations = new Set<string>();
  private readonly history: EvidencePacket[] = [];
  private readonly statePath?: string;
  private readonly verifier?: (contract: GoalContract) => IndependentVerificationResult;
  private readonly allowedBinaries: Set<string>;

  constructor(contract: GoalContract, options: CoordinatorOptions = {}) {
    const expectedHash = computeGoalHash(contract);
    if (contract.goal_hash !== expectedHash) {
      throw new Error(`goal_contract_invalid_hash: esperado ${expectedHash}, recibido ${contract.goal_hash}`);
    }
    this.contract = Object.freeze({ ...contract });
    this.statePath = options.statePath;
    this.verifier = options.verifier;
    this.allowedBinaries = new Set(options.allowedBinaries ?? DEFAULT_ALLOWED_BINARIES);

    if (this.statePath && existsSync(this.statePath)) {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedCoordinatorState;
      if (raw.goal_hash !== this.contract.goal_hash) {
        throw new Error("goal_state_hash_mismatch: el estado persistido pertenece a otro contrato");
      }
      this.currentIteration = raw.currentIteration;
      for (const op of raw.seenOperations) this.seenOperations.add(op);
      for (const pkt of raw.history) this.history.push(pkt);
    }
  }

  private persistState(): void {
    if (!this.statePath) return;
    const tmp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    const payload: PersistedCoordinatorState = {
      goal_hash: this.contract.goal_hash,
      currentIteration: this.currentIteration,
      seenOperations: Array.from(this.seenOperations),
      history: this.history,
    };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
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
   * y evalúa invariantes antes de enviarlo al revisor (ChatGPT).
   */
  recordIteration(packet: EvidencePacket): CoordinatorVerdict {
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

    // Si el coordinador tiene un runner independiente configurado, ejecuta su propia verificación
    // y detecta cualquier intento del ejecutor de falsificar `independent_verification.passed = true`.
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

    // Falla 1: El ejecutor reclama PASS pero la verificación independiente falló o faltan criterios
    if (
      effectivePacket.executor_claim === "PASS" &&
      (!effectivePacket.independent_verification.passed || effectivePacket.evidence.not_demonstrated.length > 0)
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
  }

  /**
   * Evalúa la propuesta devuelta por el revisor (ChatGPT) contra el contrato,
   * la iteración actual y la evidencia independiente registrada.
   */
  evaluateReviewerProposal(proposal: ReviewerProposal): CoordinatorVerdict {
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

    // Falla 1 / Autoridad circular: GPT intenta declarar DONE sin verificación independiente completa
    if (proposal.decision === "DONE") {
      if (!latest.independent_verification.passed || latest.evidence.not_demonstrated.length > 0) {
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

    // Si propone CONTINUE, validar límites de iteración y alcance del siguiente experimento
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

      // Falla 4b: Validación por allowlist de binarios, bloqueo de shell inline y patrones destructivos
      if (nextExp.command && nextExp.command.length > 0) {
        if (!isCommandAllowed(nextExp.command, this.allowedBinaries, this.contract.allow_destructive)) {
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
