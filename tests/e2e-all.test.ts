// tests/e2e-all.test.ts — Test para el verificador unificado E2E
import { describe, expect, test } from "bun:test";
import { runE2EAll } from "../scripts/e2e-all";

describe("Unified E2E Smoke Suite", () => {
  test("ejecuta la suite e2e completa y pasa todas las verificaciones", async () => {
    const result = await runE2EAll({ quiet: true, ephemeral: true });
    expect(result.ok).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(5);

    const checkNames = result.checks.map((c) => c.name);
    expect(checkNames).toContain("health");
    expect(checkNames).toContain("metrics");
    expect(checkNames).toContain("harnesses");
    expect(checkNames).toContain("codex_launcher");
    expect(checkNames).toContain("local_guard");

    for (const check of result.checks) {
      expect(check.ok).toBe(true);
    }
  // Harness probes carry a 20s budget each and take 4-8s quiet; load can push the suite past 30 s.
  // Windows no necesita rama propia: medido aqui, la corrida completa dura 18.07 s y 18.06 s de
  // eso es el check "harnesses", porque detect() ahora si encuentra los CLI instalados (14 en esta
  // maquina) y los sondea uno por uno; antes de ese arreglo el check pasaba en 106 ms porque no
  // detectaba ninguno. Ese sondeo serial pedia 60 s, y el techo general de 90 s ya lo cubre.
  }, 90_000);
});
