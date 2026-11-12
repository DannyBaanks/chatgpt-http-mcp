// tests/gateway-registry.test.ts — glosario y handlers del gateway salen del MISMO registro.
import { describe, expect, it } from "bun:test";
import { GATEWAY_ACTIONS, PREFIX_FAMILIES, FAMILY_DESCRIPTIONS } from "../src/mcp/gateway-actions";
import { dispatchIsyMcpAction, ISYMCP_GLOSSARY } from "../src/mcp/gateway";

describe("registro único del gateway", () => {
  it("GR-01: nombres y alias únicos, sin chocar con las acciones reservadas", () => {
    const keys = GATEWAY_ACTIONS.flatMap((a) => [a.name, ...(a.aliases ?? [])]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const reserved of ["glossary", "catalog", "help", "describe"]) expect(keys).not.toContain(reserved);
  });

  it("GR-02: toda acción documentada se puede ejecutar (handler propio o familia de prefijo)", () => {
    for (const a of GATEWAY_ACTIONS) {
      const executable = Boolean(a.handler) || PREFIX_FAMILIES.some((f) => f.matches(a.name));
      expect(executable).toBe(true);
      expect(FAMILY_DESCRIPTIONS[a.family]).toBeDefined();
    }
  });

  it("GR-03: el glosario es exactamente la proyección del registro", () => {
    const fromGlossary = Object.entries(ISYMCP_GLOSSARY.families).flatMap(([f, fam]) => Object.keys(fam.actions).map((n) => `${f}:${n}`));
    expect(fromGlossary).toEqual(GATEWAY_ACTIONS.map((a) => `${a.family}:${a.name}`));
  });

  it("GR-04: describe entiende el nombre y todos los alias de cada acción", async () => {
    for (const a of GATEWAY_ACTIONS) {
      for (const n of [a.name, ...(a.aliases ?? []), ...(a.describeAliases ?? [])]) {
        const r = await dispatchIsyMcpAction("describe", { name: n });
        expect(r.ok).toBe(true);
        expect((r.result as { action: string }).action).toBe(a.name);
      }
    }
  });

  it("GR-05: lo que no existe sigue respondiendo con error claro", async () => {
    const r = await dispatchIsyMcpAction("no.existe");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no soportada");
  });
});
