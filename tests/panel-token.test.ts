// panel-token.test.ts — el panel distingue "bridge apagado" de "bridge exige token".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_AUTH_HINT, buildPanelState, renderMain, startPanel } from "../src/panel";

let home: string;
let bridge: ReturnType<typeof Bun.serve>;
const TOKEN = "panel-test-token";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "isyco-paneltok-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
  // Bridge falso que exige el token como el real.
  bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (req.headers.get("x-isymcp-token") !== TOKEN) {
        return Response.json({ error: { type: "unauthorized" } }, { status: 401 });
      }
      if (new URL(req.url).pathname === "/health") return Response.json({ status: "ok" });
      return Response.json({ phase: "idle", chat_id: null, queued: 0, since: null });
    },
  });
});

afterAll(() => {
  bridge.stop(true);
  delete process.env.CODEX_WEB_HTTP_HOME;
  delete process.env.CODEX_WEB_HTTP_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe("panel sin / con token del bridge", () => {
  test("sin token: estado 'token requerido', no 'apagado'", async () => {
    delete process.env.CODEX_WEB_HTTP_TOKEN;
    const state = await buildPanelState(String(bridge.port));
    expect(state.server).toBe("up");
    expect(state.serverAuth).toBe("token_required");
    const html = renderMain(state);
    expect(html).toContain("token requerido");
    expect(html).toContain("CODEX_WEB_HTTP_TOKEN");
    expect(html).not.toContain("apagado");
  });

  test("con token correcto: en linea", async () => {
    process.env.CODEX_WEB_HTTP_TOKEN = TOKEN;
    const state = await buildPanelState(String(bridge.port));
    expect(state.serverAuth).toBe("ok");
    expect(renderMain(state)).toContain("en linea");
  });

  test("bridge realmente apagado sigue siendo 'apagado'", async () => {
    const state = await buildPanelState("9");
    expect(state.server).toBe("down");
    expect(state.serverAuth).toBe("ok");
  });

  test("/api/chat/status sin token da un error accionable", async () => {
    delete process.env.CODEX_WEB_HTTP_TOKEN;
    const panel = startPanel(0, String(bridge.port));
    try {
      const res = await fetch(`http://127.0.0.1:${panel.port}/api/chat/status`);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe("bridge_unauthorized");
      expect(body.error.message).toBe(BRIDGE_AUTH_HINT);
    } finally {
      panel.stop(true);
    }
  });

  test("/api/chat/status con token pasa tal cual", async () => {
    process.env.CODEX_WEB_HTTP_TOKEN = TOKEN;
    const panel = startPanel(0, String(bridge.port));
    try {
      const res = await fetch(`http://127.0.0.1:${panel.port}/api/chat/status`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { phase: string }).phase).toBe("idle");
    } finally {
      panel.stop(true);
    }
  });
});
