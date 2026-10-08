// ws-native-proxy.test.ts — Codex App habla por WebSocket con TODOS los
// modelos: los nativos se reenvian al upstream con la auth del handshake.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";
import { forwardHeaders, upstreamWsUrl } from "../src/ws-native-proxy";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "isymcp-wsnative-")); process.env.CODEX_WEB_HTTP_HOME = home; });
afterAll(() => { delete process.env.CODEX_WEB_HTTP_HOME; rmSync(home, { recursive: true, force: true }); });

describe("utilidades", () => {
  test("url del upstream y cabeceras reenviadas", () => {
    expect(upstreamWsUrl("https://chatgpt.com/backend-api/codex")).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(upstreamWsUrl("http://127.0.0.1:9/")).toBe("ws://127.0.0.1:9/responses");
    const h = forwardHeaders({ authorization: "Bearer x", "chatgpt-account-id": "a", host: "127.0.0.1", "sec-websocket-key": "k", upgrade: "websocket", origin: "x" });
    expect(h).toEqual({ authorization: "Bearer x", "chatgpt-account-id": "a" });
  });
});

describe("WebSocket nativo a traves del bridge", () => {
  test("reenvia con la auth de la app, devuelve las respuestas y cierra en cadena", async () => {
    const seen: { headers: Record<string, string>; messages: string[]; closed: boolean } = { headers: {}, messages: [], closed: false };
    const upstream = Bun.serve<{ h: Record<string, string> }>({
      hostname: "127.0.0.1", port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname !== "/responses") return new Response("no", { status: 404 });
        return srv.upgrade(req, { data: { h: Object.fromEntries(req.headers) } }) ? undefined : new Response("x", { status: 400 });
      },
      websocket: {
        open(ws) { seen.headers = ws.data.h; },
        message(ws, msg) {
          seen.messages.push(String(msg));
          const body = JSON.parse(String(msg)) as { model?: string };
          ws.send(JSON.stringify({ type: "response.created", echo: body.model ?? "evento" }));
        },
        close() { seen.closed = true; },
      },
    });
    const bridge = startServer(loadConfig({ CODEX_WEB_HTTP_PORT: "0", CODEX_WEB_HTTP_WEB_MODELS: "on", CODEX_WEB_HTTP_UPSTREAM: `http://127.0.0.1:${upstream.port}` }));
    try {
      const client = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/responses`, { headers: { authorization: "Bearer token-de-la-app", "chatgpt-account-id": "acct-1" } } as unknown as string[]);
      const received: string[] = [];
      client.onmessage = (e) => received.push(String(e.data));
      await new Promise<void>((resolve, reject) => { client.onopen = () => resolve(); client.onerror = () => reject(new Error("ws")); });
      // Dos mensajes seguidos: el segundo llega antes de que el upstream abra (cola).
      client.send(JSON.stringify({ type: "response.create", model: "gpt-6.1-sol", input: "hola" }));
      client.send(JSON.stringify({ type: "response.cancel" }));
      for (let i = 0; i < 50 && received.length < 2; i++) await Bun.sleep(50);
      expect(received.map((r) => JSON.parse(r).echo)).toEqual(["gpt-6.1-sol", "evento"]);
      expect(seen.messages).toHaveLength(2);
      expect(seen.headers.authorization).toBe("Bearer token-de-la-app");
      expect(seen.headers["chatgpt-account-id"]).toBe("acct-1");
      client.close();
      for (let i = 0; i < 40 && !seen.closed; i++) await Bun.sleep(50);
      expect(seen.closed).toBe(true);
    } finally {
      bridge.stop(true);
      upstream.stop(true);
    }
  });

  test("un evento sin modelo en una conexion nueva se rechaza (no abre upstream)", async () => {
    const bridge = startServer(loadConfig({ CODEX_WEB_HTTP_PORT: "0", CODEX_WEB_HTTP_WEB_MODELS: "on", CODEX_WEB_HTTP_UPSTREAM: "http://127.0.0.1:1" }));
    try {
      const client = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/responses`);
      const got = new Promise<string>((resolve) => { client.onmessage = (e) => resolve(String(e.data)); });
      await new Promise<void>((resolve) => { client.onopen = () => resolve(); });
      client.send(JSON.stringify({ type: "response.cancel" }));
      expect(JSON.parse(await got).error.type).toBe("ws_bad_request");
      client.close();
    } finally {
      bridge.stop(true);
    }
  });
});
