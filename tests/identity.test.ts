import { describe, expect, test } from "bun:test";
import {
  CODEX_TOOLS,
  COMMAND_MARKER,
  CONNECTOR_NAME,
  MENTION,
  buildChatGPTCommand,
  buildInstructions,
} from "../src/mcp/identity";

describe("identidad del connector", () => {
  test("el nombre es exactamente el pedido", () => {
    expect(CONNECTOR_NAME).toBe("Codex ISyMCP");
  });

  test("el token @ es el pedido", () => {
    expect(MENTION).toBe("@CODEX ISYMCP");
  });

  test("son 8 tools, iguales a las del Codex GPT MCP", () => {
    expect(CODEX_TOOLS).toHaveLength(8);
    expect([...CODEX_TOOLS].sort()).toEqual([
      "codex_apply_patch",
      "codex_exec",
      "codex_tool_call",
      "codex_tool_inventory",
      "codex_turn_complete",
      "codex_turn_start",
      "codex_view_image",
      "codex_write_stdin",
    ]);
  });
});

describe("instructions", () => {
  test("nombran el app y el token, yolkSIEMCP no es obligatorio que este pegado", () => {
    for (const contract of ["native", "safe"] as const) {
      const text = buildInstructions(contract);
      expect(text).toContain(CONNECTOR_NAME);
      expect(text).toContain(MENTION);
      expect(text).toContain("codex_turn_start");
      expect(text).toContain("codex_turn_complete");
    }
  });

  test("el contrato determina la clave del turno", () => {
    expect(buildInstructions("native")).toContain("turn_token");
    expect(buildInstructions("safe")).toContain("request_id");
  });

  test("el flujo texto -> @ -> ACK queda escrito", () => {
    expect(buildInstructions("native")).toContain("ACK");
  });

  test("bootstrap minimo: sin el contrato del transporte externo", () => {
    for (const contract of ["native", "safe"] as const) {
      const text = buildInstructions(contract);
      expect(text).not.toContain("ISYMCP CODEX RESPONSE CONTRACT");
      expect(text.length).toBeLessThan(2200);
    }
  });
});

describe("buildChatGPTCommand", () => {
  test("el texto va primero y el comando @ al final", () => {
    const out = buildChatGPTCommand("arregla el test que falla");
    expect(out.startsWith("arregla el test que falla")).toBe(true);
    expect(out).toContain(`${COMMAND_MARKER} ${MENTION}`);
    expect(out.indexOf(MENTION)).toBeGreaterThan(out.indexOf("arregla el test"));
  });

  test("con turn_token lo incluye y rotula segun el prefijo", () => {
    expect(buildChatGPTCommand("t", { turnToken: "turn_abc" })).toContain("turn_token: turn_abc");
    expect(buildChatGPTCommand("t", { turnToken: "req_abc" })).toContain("request_id: req_abc");
  });

  test("pide explicitamente ejecutar aunque parezca texto plano", () => {
    const out = buildChatGPTCommand("t", { effort: "high" });
    expect(out).toContain("Ejecuta la tarea");
    expect(out).toContain("effort: high");
  });
});