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
  });
});
