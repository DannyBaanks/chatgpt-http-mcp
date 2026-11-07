import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePacketHash,
  createGoalContract,
  formatReviewerPrompt,
  GoalCoordinator,
  parseReviewerProposal,
  type EvidencePacket,
  type GoalContract,
} from "../src/goal-loop";

describe("GOAL-001 — Autonomous Review Loop Coordinator", () => {
  let workspace: string;
  let outsideDir: string;
  let contract: GoalContract;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "isymcp-goal-001-"));
    outsideDir = mkdtempSync(join(tmpdir(), "isymcp-outside-001-"));
    writeFileSync(join(outsideDir, "secret.txt"), "top-secret");

    contract = createGoalContract({
      goal_id: "GOAL-001",
      description: "Validar integridad del coordinador ante 5 modos de fallo deliberados",
      max_iterations: 5,
      allowed_cwd: workspace,
      allow_destructive: false,
      acceptance_criteria: [
        "Rechazar PASS sin evidencia verificada independientemente",
        "Rechazar respuestas de iteraciones obsoletas",
        "Bloquear operaciones duplicadas (idempotencia)",
        "Bloquear propuestas fuera de alcance o destructivas",
        "Detener ante dos iteraciones consecutivas sin progreso verificable",
      ],
      verification_command: ["bun", "test", "tests/goal-loop.test.ts"],
    });
  });

  afterAll(() => {
    try {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    } catch {}
  });

  function makePacket(overrides: Partial<EvidencePacket> = {}): EvidencePacket {
    return {
      goal_id: contract.goal_id,
      iteration: 1,
      operation_id: "exec-op-1",
      goal_hash: contract.goal_hash,
      repo: {
        base_sha: "0a103be031df0cae03096626f9f94b1d00ee7d3a",
        head_sha: "1111111111111111111111111111111111111111",
        dirty: true,
      },
      execution: {
        commands: ["bun test"],
        exit_codes: [1],
      },
      evidence: {
        demonstrated: ["4/5 tests passed"],
        inferred: ["Falta validar borde de timeout"],
        not_demonstrated: ["All tests passing"],
      },
      executor_claim: "IN_PROGRESS",
      independent_verification: {
        passed: false,
        exit_code: 1,
        output_summary: "4 pass, 1 fail",
        artifact_hash: "sha256:aaa111",
      },
      status: "REVIEW_REQUIRED",
      ...overrides,
    };
  }

  test("Fallo 1: rechaza autovalidación cuando Gemini declara PASS o GPT declara DONE sin evidencia verificada", () => {
    const coord = new GoalCoordinator(contract);

    // Caso 1a: Gemini reclama PASS pero independent_verification.passed es false
    const prematureClaim = makePacket({
      iteration: 1,
      operation_id: "op-premature-pass",
      executor_claim: "PASS",
    });
    const execVerdict = coord.recordIteration(prematureClaim);
    expect(execVerdict.decision).toBe("DENY");
    expect(execVerdict.reason).toBe("unverified_pass_claim");

    // Caso 1b: GPT intenta declarar DONE por autoridad circular cuando aún hay criterios no demostrados
    const revVerdict = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-premature-done",
      decision: "DONE",
      rationale: "Acepto los 4 tests y doy por bueno el quinto",
      preconditions: [],
    });
    expect(revVerdict.decision).toBe("DENY");
    expect(revVerdict.reason).toBe("unverified_pass_claim");
  });

  test("Fallo 2: rechaza respuesta de GPT correspondiente a una iteración anterior (stale iteration)", () => {
    const coord = new GoalCoordinator(contract);

    coord.recordIteration(makePacket({ iteration: 1, operation_id: "op-it-1" }));
    coord.recordIteration(
      makePacket({
        iteration: 2,
        operation_id: "op-it-2",
        repo: {
          base_sha: "0a103be031df0cae03096626f9f94b1d00ee7d3a",
          head_sha: "2222222222222222222222222222222222222222",
          dirty: true,
        },
      }),
    );

    // El coordinador ya está en la iteración 2, pero GPT responde a la iteración 1
    const staleVerdict = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-stale-it1",
      decision: "CONTINUE",
      rationale: "Corrección para la iteración 1",
      preconditions: [],
    });

    expect(staleVerdict.decision).toBe("DENY");
    expect(staleVerdict.reason).toBe("stale_iteration_response");
  });

  test("Fallo 3: bloquea operaciones duplicadas para garantizar idempotencia ante reintentos", () => {
    const coord = new GoalCoordinator(contract);

    const first = coord.recordIteration(makePacket({ iteration: 1, operation_id: "op-dup-1" }));
    expect(first.decision).toBe("CONTINUE");

    // Reintento con el mismo operation_id
    const duplicateExec = coord.recordIteration(makePacket({ iteration: 2, operation_id: "op-dup-1" }));
    expect(duplicateExec.decision).toBe("DENY");
    expect(duplicateExec.reason).toBe("duplicate_operation_id");

    // Propuesta del revisor aceptada una vez y rechazada si llega duplicada
    const firstRev = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-dup-1",
      decision: "CONTINUE",
      rationale: "Siguiente paso",
      preconditions: [],
    });
    expect(firstRev.decision).toBe("CONTINUE");

    const duplicateRev = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-dup-1",
      decision: "CONTINUE",
      rationale: "Reintento por timeout",
      preconditions: [],
    });
    expect(duplicateRev.decision).toBe("DENY");
    expect(duplicateRev.reason).toBe("duplicate_operation_id");
  });

  test("Fallo 4: bloquea propuestas fuera del workspace autorizado, destructivas o que muten el goal_hash", () => {
    const coord = new GoalCoordinator(contract);
    coord.recordIteration(makePacket({ iteration: 1, operation_id: "op-scope-1" }));

    // 4a: Directorio fuera del workspace permitido
    const outOfScope = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-outside-cwd",
      decision: "CONTINUE",
      rationale: "Inspeccionar /etc",
      preconditions: [],
      next_experiment: {
        description: "Salir del workspace",
        target_cwd: "/etc",
        command: ["git", "status"],
      },
    });
    expect(outOfScope.decision).toBe("DENY");
    expect(outOfScope.reason).toBe("out_of_scope_or_destructive");

    // 4b: Comando destructivo prohibido
    const destructive = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-destructive",
      decision: "CONTINUE",
      rationale: "Limpiar árbol a la fuerza",
      preconditions: [],
      next_experiment: {
        description: "Reset hard",
        target_cwd: workspace,
        command: ["git", "reset", "--hard", "HEAD~1"],
      },
    });
    expect(destructive.decision).toBe("DENY");
    expect(destructive.reason).toBe("out_of_scope_or_destructive");

    // 4c: Intento de alterar el goal_hash / criterios de aceptación
    const mutatedGoal = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-mutate-goal",
      decision: "CONTINUE",
      rationale: "Redefinir criterios",
      preconditions: [],
      next_experiment: {
        description: "Bajar la barra de aceptación",
        override_goal_hash: "sha256:forged_hash_000",
      },
    });
    expect(mutatedGoal.decision).toBe("DENY");
    expect(mutatedGoal.reason).toBe("goal_mutation_forbidden");
  });

  test("Fallo 5: detiene el ciclo con PAUSE cuando encadena dos iteraciones sin progreso verificable", () => {
    const coord = new GoalCoordinator(contract);

    const it1 = coord.recordIteration(makePacket({ iteration: 1, operation_id: "op-stag-1" }));
    expect(it1.decision).toBe("CONTINUE");

    // Iteración 2 con exactamente el mismo head_sha, mismos exit_codes y misma evidencia demostrada
    const it2 = coord.recordIteration(makePacket({ iteration: 2, operation_id: "op-stag-2" }));
    expect(it2.decision).toBe("PAUSE");
    expect(it2.reason).toBe("stagnation_detected");
  });

  test("Ciclo completo válido: progreso demostrable + verificación independiente habilita DONE", () => {
    const coord = new GoalCoordinator(contract);

    // Iteración 1: en progreso
    const v1 = coord.recordIteration(makePacket({ iteration: 1, operation_id: "op-valid-1" }));
    expect(v1.decision).toBe("CONTINUE");

    const r1 = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-valid-1",
      decision: "CONTINUE",
      rationale: "Falta cubrir el quinto caso",
      preconditions: ["4/5 pasando"],
      next_experiment: {
        description: "Ejecutar suite completa",
        target_cwd: workspace,
        command: ["bun", "test", "tests/goal-loop.test.ts"],
      },
    });
    expect(r1.decision).toBe("CONTINUE");
    expect(r1.authorized_command).toEqual(["bun", "test", "tests/goal-loop.test.ts"]);

    // Iteración 2: todos los criterios demostrados y verificador independiente en verde
    const packet2 = makePacket({
      iteration: 2,
      operation_id: "op-valid-2",
      repo: {
        base_sha: "0a103be031df0cae03096626f9f94b1d00ee7d3a",
        head_sha: "3333333333333333333333333333333333333333",
        dirty: false,
      },
      execution: { commands: ["bun test tests/goal-loop.test.ts"], exit_codes: [0] },
      evidence: {
        demonstrated: contract.acceptance_criteria,
        inferred: [],
        not_demonstrated: [],
      },
      executor_claim: "PASS",
      independent_verification: {
        passed: true,
        exit_code: 0,
        output_summary: "6 pass, 0 fail",
        artifact_hash: "sha256:verified777",
      },
      status: "VERIFIED",
    });

    const v2 = coord.recordIteration(packet2);
    expect(v2.decision).toBe("CONTINUE");

    const prompt = formatReviewerPrompt(contract, packet2);
    expect(prompt).toContain(contract.goal_hash);

    const simulatedChatGptReply = [
      "Excelente trabajo, la evidencia independiente confirma los 5 criterios.",
      "```json",
      JSON.stringify({
        goal_id: contract.goal_id,
        reviewed_iteration: 2,
        reviewed_packet_hash: computePacketHash(packet2),
        operation_id: "rev-valid-2",
        decision: "DONE",
        rationale: "Los 5 modos de fallo fueron demostrados con exit_code 0 e integridad de contrato.",
        preconditions: ["independent_verification.passed === true", "not_demonstrated.length === 0"],
      }),
      "```",
    ].join("\n");

    const parsedProposal = parseReviewerProposal(simulatedChatGptReply);
    const finalVerdict = coord.evaluateReviewerProposal(parsedProposal);
    expect(finalVerdict.decision).toBe("DONE");
    expect(finalVerdict.reason).toBe("all_criteria_demonstrated");
  });

  // ── Pruebas Adversariales Solicitadas por ChatGPT en Iteración 1 ──────────

  test("Adversarial 1: rechaza escapes de workspace mediante symlinks y rutas relativas (../)", () => {
    const symlinkPath = join(workspace, "escape-symlink");
    try {
      symlinkSync(outsideDir, symlinkPath);
    } catch {}
    const subDir = join(workspace, "nested");
    mkdirSync(subDir, { recursive: true });

    const coord = new GoalCoordinator(contract);
    coord.recordIteration(makePacket({ iteration: 1, operation_id: "op-adv-sym-1" }));

    // Intento de usar un symlink dentro de allowed_cwd que apunta a outsideDir
    const symEscape = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-adv-symlink",
      decision: "CONTINUE",
      rationale: "Intentar leer a través de symlink",
      preconditions: [],
      next_experiment: {
        description: "Symlink traversal",
        target_cwd: join(symlinkPath, "sub"),
        command: ["git", "status"],
      },
    });
    expect(symEscape.decision).toBe("DENY");
    expect(symEscape.reason).toBe("out_of_scope_or_destructive");

    // Intento de traversal con ..
    const dotDotEscape = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-adv-dotdot",
      decision: "CONTINUE",
      rationale: "Traversal relativo",
      preconditions: [],
      next_experiment: {
        description: "Dot-dot traversal",
        target_cwd: join(workspace, "..", ".."),
        command: ["git", "status"],
      },
    });
    expect(dotDotEscape.decision).toBe("DENY");
    expect(dotDotEscape.reason).toBe("out_of_scope_or_destructive");

    // Subdirectorio real dentro de workspace sí es permitido
    const validSub = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-adv-valid-sub",
      decision: "CONTINUE",
      rationale: "Subdirectorio legítimo",
      preconditions: [],
      next_experiment: {
        description: "Subdirectorio válido",
        target_cwd: subDir,
        command: ["git", "status"],
      },
    });
    expect(validSub.decision).toBe("CONTINUE");
  });

  test("Adversarial 2: detecta y bloquea falsificación de independent_verification.passed por el ejecutor", () => {
    // El coordinador posee su propio verifier independiente que observa un fallo real (exit_code: 1)
    const coord = new GoalCoordinator(contract, {
      verifier: () => ({
        passed: false,
        exit_code: 1,
        output_summary: "Real verifier observed 1 failing test",
        artifact_hash: "sha256:real_verifier_hash",
      }),
    });

    // El ejecutor miente en el paquete declarando independent_verification.passed = true y executor_claim = PASS
    const forgedPacket = makePacket({
      iteration: 1,
      operation_id: "op-forged-verif",
      executor_claim: "PASS",
      evidence: {
        demonstrated: contract.acceptance_criteria,
        inferred: [],
        not_demonstrated: [],
      },
      independent_verification: {
        passed: true,
        exit_code: 0,
        output_summary: "Forged by executor",
        artifact_hash: "sha256:forged",
      },
      status: "VERIFIED",
    });

    const verdict = coord.recordIteration(forgedPacket);
    expect(verdict.decision).toBe("DENY");
    expect(verdict.reason).toBe("unverified_pass_claim");

    // Y si el revisor intenta dar DONE sobre ese estado, también es rechazado porque el coordinador sobrescribió con la verdad
    const revVerdict = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-after-forged",
      decision: "DONE",
      rationale: "Intentar cerrar pese a falsificación",
      preconditions: [],
    });
    expect(revVerdict.decision).toBe("DENY");
    expect(revVerdict.reason).toBe("unverified_pass_claim");
  });

  test("Adversarial 3: deduplicación atómica de operation_id persiste tras reinicio del coordinador", () => {
    const statePath = join(workspace, "coordinator-state.json");
    const coord1 = new GoalCoordinator(contract, { statePath });

    const v1 = coord1.recordIteration(makePacket({ iteration: 1, operation_id: "op-persist-1" }));
    expect(v1.decision).toBe("CONTINUE");

    const r1 = coord1.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-persist-1",
      decision: "CONTINUE",
      rationale: "Paso 1 revisado",
      preconditions: [],
    });
    expect(r1.decision).toBe("CONTINUE");

    // Simulamos caída y reinicio del proceso creando una nueva instancia desde statePath
    const coordRestarted = new GoalCoordinator(contract, { statePath });
    expect(coordRestarted.iteration).toBe(1);

    // Reenviar op-persist-1 o rev-persist-1 tras el reinicio debe fallar cerrado
    const replayExec = coordRestarted.recordIteration(makePacket({ iteration: 2, operation_id: "op-persist-1" }));
    expect(replayExec.decision).toBe("DENY");
    expect(replayExec.reason).toBe("duplicate_operation_id");

    const replayRev = coordRestarted.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-persist-1",
      decision: "CONTINUE",
      rationale: "Replay tras reinicio",
      preconditions: [],
    });
    expect(replayRev.decision).toBe("DENY");
    expect(replayRev.reason).toBe("duplicate_operation_id");
  });

  test("Adversarial 4: rechaza head_sha simbólico no-Git y propuestas con goal_hash válido pero packet_hash obsoleto", () => {
    const coord = new GoalCoordinator(contract);

    // 4a: SHA simbólico como "0a103be+feat/goal-001" debe ser rechazado
    const badShaVerdict = coord.recordIteration(
      makePacket({
        iteration: 1,
        operation_id: "op-bad-sha",
        repo: {
          base_sha: "0a103be031df0cae03096626f9f94b1d00ee7d3a",
          head_sha: "0a103be031df0cae03096626f9f94b1d00ee7d3a+feat/goal-001",
          dirty: true,
        },
      }),
    );
    expect(badShaVerdict.decision).toBe("DENY");
    expect(badShaVerdict.reason).toBe("invalid_git_sha");

    // Registramos iteración 1 válida
    const validIt1 = coord.recordIteration(makePacket({ iteration: 1, operation_id: "op-good-sha-1" }));
    expect(validIt1.decision).toBe("CONTINUE");

    // 4b: El revisor envía el goal_hash y reviewed_iteration=1 correctos, pero con un reviewed_packet_hash de otro estado
    const mismatchedPacketHash = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      reviewed_packet_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      operation_id: "rev-bad-pkt-hash",
      decision: "CONTINUE",
      rationale: "Estado desincronizado",
      preconditions: [],
    });
    expect(mismatchedPacketHash.decision).toBe("DENY");
    expect(mismatchedPacketHash.reason).toBe("stale_iteration_response");
  });

  test("Adversarial 5: autorización de comandos exige binario en allowlist y bloquea ejecución inline (-e / -c)", () => {
    const coord = new GoalCoordinator(contract);
    coord.recordIteration(makePacket({ iteration: 1, operation_id: "op-cmd-guard-1" }));

    // Binario fuera de allowlist (ej. bash o curl) aunque no coincida con regex de rm/reset
    const unlistedBin = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-unlisted-bin",
      decision: "CONTINUE",
      rationale: "Intentar invocar shell",
      preconditions: [],
      next_experiment: {
        description: "Shell arbitrario",
        target_cwd: workspace,
        command: ["bash", "script.sh"],
      },
    });
    expect(unlistedBin.decision).toBe("DENY");
    expect(unlistedBin.reason).toBe("out_of_scope_or_destructive");

    // Binario permitido (bun) pero con flag de evaluación inline (-e) para inyectar código arbitrario
    const inlineEval = coord.evaluateReviewerProposal({
      goal_id: contract.goal_id,
      reviewed_iteration: 1,
      operation_id: "rev-inline-eval",
      decision: "CONTINUE",
      rationale: "Inyectar eval",
      preconditions: [],
      next_experiment: {
        description: "Eval inline",
        target_cwd: workspace,
        command: ["bun", "-e", "console.log(process.env)"],
      },
    });
    expect(inlineEval.decision).toBe("DENY");
    expect(inlineEval.reason).toBe("out_of_scope_or_destructive");
  });
});
