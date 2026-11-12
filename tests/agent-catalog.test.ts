// tests/agent-catalog.test.ts — una sola fuente de verdad: las tres vistas salen del mismo catálogo
// y no pueden volver a desincronizarse (como cuando openisy escribía en ~/.config/opencode).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, agentConfigFile, findAgent } from "../src/agents/catalog";
import { AGENT_TUIS, resolveAgentTui } from "../src/agent-tuis";
import { CATALOG } from "../src/harness";
import { detectTuis, TUI_ALIASES } from "../src/tui";

const HOME_VARS = ["CURSOR_HOME", "OPENCODE_HOME", "OPENISY_HOME", "AGY_HOME", "KIMI_HOME", "CRUSH_HOME", "OPENISY_CONFIG_DIR"];
let home: string;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "agent-catalog-"));
  for (const k of HOME_VARS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

describe("catálogo único de agentes", () => {
  it("AC-01: ids y alias únicos en todo el catálogo", () => {
    const keys = AGENTS.flatMap((a) => [a.id, ...a.aliases]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of AGENTS) expect(findAgent(a.id)).toBe(a);
  });

  it("AC-02: lo que se edita como JSON declara su archivo; lo que no tiene estrategia dice por qué", () => {
    for (const a of AGENTS) {
      if (a.mcp) {
        const strategy = a.mcp(() => "/x");
        if (strategy.kind === "json") expect(a.config?.file).toBeDefined();
      } else {
        expect(a.pending).toBeTruthy();
      }
      if (a.tuiFormat === "mcpServers" || a.tuiFormat === "opencode") expect(a.config?.file).toBeDefined();
      if (a.console) expect(a.executables.length).toBeGreaterThan(0);
    }
  });

  it("AC-03: las tres vistas son exactamente proyecciones del catálogo", () => {
    expect(CATALOG.map((h) => h.id)).toEqual(AGENTS.filter((a) => a.executables.length > 0).map((a) => a.id));
    expect(AGENT_TUIS.map((t) => t.id)).toEqual(AGENTS.filter((a) => a.console).map((a) => a.id));
    expect(detectTuis(home).map((t) => t.id)).toEqual(AGENTS.filter((a) => a.tuiFormat).map((a) => a.id));
    for (const t of AGENT_TUIS) expect(t.label).toBe(findAgent(t.id)!.label);
    expect(TUI_ALIASES["open-isy"]).toBe("openisy");
    expect(TUI_ALIASES.antigravity).toBe("agy");
    expect(resolveAgentTui("factory")?.id).toBe("droid");
  });

  it("AC-04: harness y `tui install` usan la MISMA ruta de config para cada agente", () => {
    for (const k of ["OPENCODE_HOME", "OPENISY_HOME", "AGY_HOME", "KIMI_HOME", "CRUSH_HOME", "CURSOR_HOME"]) process.env[k] = home;
    try {
      const tuis = Object.fromEntries(detectTuis(home).map((t) => [t.id, t]));
      for (const h of CATALOG) {
        if (h.strategy?.kind !== "json") continue;
        expect(h.strategy.configPath()).toBe(tuis[h.id]!.configPath);
        expect(h.strategy.configPath()).toBe(agentConfigFile(findAgent(h.id)!)!);
      }
      // Los casos que se desincronizaron antes, explícitos:
      expect(tuis.openisy!.configPath).toBe(join(home, ".openisy", "config", "opencode.json"));
      expect(tuis.agy!.configPath).toBe(join(home, ".gemini", "config", "mcp_config.json"));
      expect(tuis.gemini!.configPath).toBe(join(home, ".gemini", "settings.json"));
    } finally {
      for (const k of ["OPENCODE_HOME", "OPENISY_HOME", "AGY_HOME", "KIMI_HOME", "CRUSH_HOME", "CURSOR_HOME"]) delete process.env[k];
    }
  });
});
