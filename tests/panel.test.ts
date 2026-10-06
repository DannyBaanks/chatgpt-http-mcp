// M13a: estado del panel + render (read-only).
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPanelState, renderPanel } from "../src/panel";

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

  test("render incluye cards y el estado", async () => {
    const html = renderPanel(await buildPanelState("59999"));
    for (const label of ["SERVER", "TUNEL", "MCP STDIO", "BROWSER", "CONVERSACION", "SESIONES MCP", "ULTIMOS ERRORES"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("ISyMCP PANEL");
  });
});
