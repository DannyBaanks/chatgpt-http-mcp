// Fase 6 (COMPOSE): parser de la variante de DOM capturada en el dump
// capture-fail-2026-10-06 (sin .markdown; contenedor con ambos lados).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractResponse } from "../src/web-turn";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "capture-fail-container.json"), "utf8"),
) as { assistantPrimary: { lastText: string } };

describe("extractResponse sobre el dump real", () => {
  test("extrae el nonce del contenedor que incluye el turno del usuario", () => {
    const text = extractResponse(fixture.assistantPrimary.lastText);
    expect(text).toBe("HTTP-px0smg");
  });

  test("contenedor sin marcador del asistente devuelve vacio", () => {
    expect(extractResponse("Tú dijiste: hola\nuser: algo")).toBe("");
  });

  test("sin respuesta no hay falso PASS", () => {
    expect(extractResponse("")).toBe("");
    expect(extractResponse("puro texto de usuario")).toBe("");
  });
});
