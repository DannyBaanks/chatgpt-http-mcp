// M6 (P0): tabla de clasificacion de errores -> status HTTP estable.
import { describe, expect, test } from "bun:test";
import { classifyWebError } from "../src/error-taxonomy";

describe("M6: error taxonomy", () => {
  const cases: Array<[string, number]> = [
    ["not_web_model: solo modelos chatgpt-web/*", 400],
    ["chat_invalid_json: el body no es JSON", 400],
    ["web_empty_prompt: prompt vacio", 400],
    ["web_session_missing: no existe storage-state", 401],
    ["web_session_expired: cookies vencidas", 401],
    ["web_connector_unavailable: Codex ISyMCP (intento 3)", 409],
    ["web_turn_submit_failed: submitted=false ms=17326", 502],
    ["web_capture_empty: submitted=true ms=94885", 504],
    ["web_browser_missing: binario no encontrado", 503],
    ["web_page_crashed: la pagina crasheo", 503],
    ["web_turn_failed: algo raro", 500],
  ];
  for (const [message, status] of cases) {
    test(`${message.split(":")[0]} -> ${status}`, () => {
      const out = classifyWebError(message);
      expect(out.status).toBe(status);
      expect(out.type).toBe(message.split(":")[0]!);
    });
  }
  test("mensaje sin tipo conocido -> web_turn_failed/500", () => {
    expect(classifyWebError("boom sin prefijo")).toEqual({ type: "web_turn_failed", status: 500 });
    expect(classifyWebError("otro_nombre: x")).toEqual({ type: "web_turn_failed", status: 500 });
  });
});
