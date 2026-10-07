// M13a: estado del panel + render (read-only).
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPanelState, renderPanel, runPanelAction } from "../src/panel";

beforeAll(() => {
  process.env.CODEX_WEB_HTTP_HOME = mkdtempSync(join(tmpdir(), "isyco-panel-home-"));
});

describe("M13a panel read-only", () => {
  test("estado con server caido (puerto cerrado) es honesto", async () => {
    const state = await buildPanelState("59999");
    expect(state.server).toBe("down");
    expect(["ready", "stopped"]).toContain(state.tunnel);
    expect(["up", "down"]).toContain(state.mcp);
    expect(["ok", "page-crashed"]).toContain(state.browser);
    expect(Array.isArray(state.sessions)).toBe(true);
  });

  test("accion desconocida falla cerrado; session-list ejecuta el CLI", () => {
    expect(runPanelAction("rm-rf").ok).toBe(false);
    const list = runPanelAction("session-list");
    expect(list.ok).toBe(true);
    expect(list.out.length).toBeGreaterThan(0);
  }, 30_000);

  test("render incluye cards y el estado", async () => {
    const html = renderPanel(await buildPanelState("59999"));
    for (const label of ["SERVER", "TUNEL", "MCP STDIO", "BROWSER", "CONVERSACION", "SESIONES MCP", "ULTIMOS ERRORES"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("ISyMCP PANEL");
  });
});

describe("panel visual", () => {
  test("lee la ultima prueba de soak y la pinta turno por turno", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { readLastSoak, renderMain } = await import("../src/panel");
    const dir = mkdtempSync(join(tmpdir(), "isyco-panel-ev-"));
    writeFileSync(join(dir, "soak-tools-1.json"), JSON.stringify({
      ts: "2026-10-07T05:30:00Z", n: 2, ok: 1,
      results: [{ i: 1, name: "echo", ok: true, reply: "X" }, { i: 2, name: "cat", ok: false, reply: "bloqueado" }],
    }));
    const soak = readLastSoak(dir);
    expect(soak?.ok).toBe(1);
    expect(soak?.turns.map((t) => t.name)).toEqual(["echo", "cat"]);
    const main = renderMain({ ...(await buildPanelState("59999")), lastSoak: soak });
    expect(main).toContain('id="main"');
    expect(main).toContain("1 fallo");
    expect(main).toContain('class="t-bad"');
  });
});
