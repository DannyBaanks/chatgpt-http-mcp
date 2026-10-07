// web-selection.test.ts — verificacion de modelo/esfuerzo visibles (M8).
import { describe, expect, test } from "bun:test";
import { assertWebSelection } from "../src/responses/selection";

const seen = (effort: string, pos: number | null = 3, steps: number | null = 3, model = "GPT-5.6 Sol") =>
  ({ pill: effort, model, effort, effortPosition: pos, effortSteps: steps });

describe("assertWebSelection", () => {
  test("acepta High y su etiqueta localizada (Alta) solo en 3/3", () => {
    expect(() => assertWebSelection("chatgpt-web/gpt-5.6-sol", "high", seen("High"))).not.toThrow();
    expect(() => assertWebSelection("chatgpt-web/gpt-5.6-sol", "high", seen("Alta"))).not.toThrow();
  });
  test("rechaza posicion desconocida, otro nivel u otro modelo (fail closed)", () => {
    expect(() => assertWebSelection("chatgpt-web/gpt-5.6-sol", "high", seen("High", null, null))).toThrow(/web_model_state_mismatch/);
    expect(() => assertWebSelection("chatgpt-web/gpt-5.6-sol", "high", seen("Alta", 2, 3))).toThrow(/web_model_state_mismatch/);
    expect(() => assertWebSelection("chatgpt-web/gpt-5.6-sol", "high", seen("Instant", 1, 3))).toThrow(/web_model_state_mismatch/);
    expect(() => assertWebSelection("chatgpt-web/gpt-5.6-sol", "high", seen("High", 3, 3, "GPT-5.5"))).toThrow(/web_model_state_mismatch/);
  });
  test("solo Sol/high esta soportado en esta entrega", () => {
    expect(() => assertWebSelection("chatgpt-web/gpt-5.6-sol", "medium")).toThrow(/web_model_selection_unsupported/);
  });
});
