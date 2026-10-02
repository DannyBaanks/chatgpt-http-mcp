// catalog.test.ts — M3: gating por capabilities, limits por effort,
// augment sin mutar, template obligatorio y diff de filas.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  augmentCatalog,
  availableRoutes,
  diffWebRows,
  PRO_STANDARD_CONTEXT_WINDOW,
  resolveLimits,
  routeEfforts,
} from "../src/web-models";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "native-models.sample.json"), "utf8"),
) as unknown;

const SOL = { solAvailable: true, proAvailable: false } as const;
const SOL_PRO = { solAvailable: true, proAvailable: true } as const;
const SOL_PRO_XH = { solAvailable: true, proAvailable: true, extraHighAvailable: true } as const;
const LUNA = { solAvailable: false, proAvailable: false } as const;

test("gating: luna-only, sol, pro y extra high", () => {
  expect(availableRoutes(LUNA).map((r) => r.slug)).toEqual(["chatgpt-web/gpt-5.6-luna"]);
  expect(availableRoutes(SOL).map((r) => r.slug)).toEqual([
    "chatgpt-web/gpt-5.6-sol-instant",
    "chatgpt-web/gpt-5.6-sol",
    "chatgpt-web/gpt-6.1-sol",
  ]);
  expect(availableRoutes(SOL_PRO).map((r) => r.slug)).toEqual([
    "chatgpt-web/gpt-5.6-sol-instant",
    "chatgpt-web/gpt-5.6-sol",
    "chatgpt-web/gpt-6.1-sol",
    "chatgpt-web/gpt-5.6-pro",
    "chatgpt-web/gpt-6-pro",
  ]);
  const sol = availableRoutes(SOL_PRO_XH).find((r) => r.slug === "chatgpt-web/gpt-5.6-sol")!;
  expect(routeEfforts(sol, SOL_PRO_XH)).toEqual(["medium", "high", "xhigh"]);
  expect(routeEfforts(sol, SOL)).toEqual(["medium", "high"]);
});

test("limits: instant, medium/high, pro max y bigger context", () => {
  expect(resolveLimits("gpt-5.6-sol", "low", SOL)).toEqual({
    contextWindow: 41_000,
    effectiveContextWindowPercent: Math.round((32_000 / 41_000) * 100),
    autoCompactTokenLimit: 32_000,
  });
  expect(resolveLimits("gpt-5.6-sol", "medium", SOL).contextWindow).toBe(90_000);
  expect(resolveLimits("gpt-5.6-sol", "max", SOL_PRO).contextWindow).toBe(104_000 + 8_192 + 1);
  expect(resolveLimits("gpt-5.6-luna", "low", LUNA).contextWindow).toBe(1_050_000);
  expect(resolveLimits("gpt-5.6-sol", "medium", { ...SOL, biggerContext: true }).contextWindow).toBe(90_000 * 3);
});

test("augment agrega filas Web, preserva nativas y no muta el input", () => {
  const before = JSON.stringify(fixture);
  const merged = augmentCatalog(fixture, SOL_PRO) as { models: Array<Record<string, unknown>> };
  expect(JSON.stringify(fixture)).toBe(before);
  expect(merged.models).toHaveLength(1 + 5);
  const native = merged.models[0];
  expect(native.slug).toBe("gpt-5.6-sol");
  const web = merged.models.filter((m) => (m.slug as string).startsWith("chatgpt-web/"));
  for (const row of web) {
    expect(row.visibility).toBe("list");
    expect(row.supported_in_api).toBe(true);
    expect(row.context_window).toBeGreaterThan(0);
    expect(Array.isArray(row.supported_reasoning_levels)).toBe(true);
  }
  const sol = web.find((m) => m.slug === "chatgpt-web/gpt-5.6-sol")!;
  // Con Pro disponible, TODAS las filas Sol usan el budget Pro (regla de la referencia).
  expect(sol.context_window).toBe(PRO_STANDARD_CONTEXT_WINDOW);
  expect(sol.default_reasoning_level).toBe("high");

  const mergedNoPro = augmentCatalog(fixture, SOL) as { models: Array<Record<string, unknown>> };
  const solNoPro = mergedNoPro.models.find((m) => m.slug === "chatgpt-web/gpt-5.6-sol")!;
  expect(solNoPro.context_window).toBe(90_000);
});

test("catalogo sin template o sin models falla cerrado", () => {
  expect(() => augmentCatalog({ models: [] }, SOL)).toThrow("template");
  expect(() => augmentCatalog({} as unknown, SOL)).toThrow("arreglo models");
});

test("diff de filas detecta faltantes y extras", () => {
  const full = augmentCatalog(fixture, SOL_PRO) as unknown;
  const partial = { models: [{ slug: "chatgpt-web/gpt-5.6-sol" }] } as unknown;
  const diffAgainstFull = diffWebRows(partial, full); // faltan las otras filas web
  expect(diffAgainstFull.missing.length).toBe(4);
  expect(diffAgainstFull.ok).toBe(false);
  const diffAgainstPartial = diffWebRows(full, partial); // tenemos extras, no faltantes
  expect(diffAgainstPartial.missing).toEqual([]);
  expect(diffAgainstPartial.extra).toContain("chatgpt-web/gpt-5.6-pro");
  expect(diffAgainstPartial.ok).toBe(true);
});
