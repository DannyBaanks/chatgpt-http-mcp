// mcp-provider-block.test.ts — FS-03: un bloqueo de OpenAI en la ruta MCP se
// registra en la traza, devuelve un codigo definitivo y NO se reintenta.
// Bloqueo simulado: el bridge falso responde el MISMO texto que ChatGPT Web.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BLOCK_TEXT = "OpenAI ha bloqueado esta llamada por los controles de seguridad de OpenAI.";
type Mode = "bridge_kind" | "reply_text" | "ok";

let home: string;
let mode: Mode = "bridge_kind";
let requests = 0;
let bridge: ReturnType<typeof Bun.serve>;
let client: Client;

function lastText(result: any): string {
  return result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "isymcp-block-"));
  bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ status: "ok" });
      if (path === "/isymcp/chat/turn") {
        requests++;
        if (mode === "bridge_kind") {
          return Response.json({
            ok: false,
            chat: {},
            reply: { role: "error", text: BLOCK_TEXT, meta: { kind: "provider_blocked", url: null } },
          });
        }
        if (mode === "reply_text") {
          // El bridge no lo clasifico, pero el texto es un bloqueo: la ruta MCP
          // tampoco puede entregarlo como respuesta normal ni reintentar.
          return Response.json({
            ok: true,
            chat: {},
            reply: { role: "assistant", text: BLOCK_TEXT, meta: { url: null } },
          });
        }
        return Response.json({ ok: true, chat: {}, reply: { role: "assistant", text: "respuesta normal", meta: { url: null } } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  client = new Client({ name: "block-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: "bun",
    args: [join(import.meta.dir, "../src/mcp/chatgpt.ts")],
    env: {
      ...process.env,
      CODEX_WEB_HTTP_HOME: home,
      CODEX_WEB_HTTP_PORT: String(bridge.port),
      CODEX_WEB_HTTP_TOKEN: "mcp-block-test-token",
    } as Record<string, string>,
    stderr: "ignore",
  }));
});

afterAll(async () => {
  await client?.close();
  bridge?.stop(true);
  rmSync(home, { recursive: true, force: true });
});

test("bloqueo clasificado por el bridge: codigo definitivo, traza y un solo intento", async () => {
  mode = "bridge_kind";
  requests = 0;
  const result = await client.callTool({ name: "chatgpt_ask", arguments: { prompt: "prueba de bloqueo" } });
  expect((result as any).isError).toBe(true);
  const out = lastText(result);
  expect(out).toContain("provider_blocked");
  expect(out).toContain("No se reintenta");
  expect(requests).toBe(1);
  const trace = readFileSync(join(home, "mcp-trace.log"), "utf8");
  expect(trace).toContain("provider.blocked");
  expect(trace).toContain('"code":"provider_blocked"');
  expect(trace).toContain('"retry":false');
  expect(trace).toContain('"tool":"chatgpt_ask"');
  expect(trace).toContain('"source":"bridge_kind"');
});

test("bloqueo no clasificado por el bridge: mismo freno, sin reintento", async () => {
  mode = "reply_text";
  requests = 0;
  const result = await client.callTool({ name: "chatgpt_ask", arguments: { prompt: "otra prueba de bloqueo" } });
  expect((result as any).isError).toBe(true);
  expect(lastText(result)).toContain("provider_blocked");
  expect(requests).toBe(1);
  const trace = readFileSync(join(home, "mcp-trace.log"), "utf8");
  expect(trace).toContain('"source":"reply_text"');
  expect((trace.match(/provider\.blocked/g) ?? []).length).toBe(2);
});

test("control positivo: una respuesta normal no dispara el freno", async () => {
  mode = "ok";
  requests = 0;
  const result = await client.callTool({ name: "chatgpt_ask", arguments: { prompt: "hola" } });
  expect((result as any).isError).toBeUndefined();
  expect(lastText(result)).toContain("respuesta normal");
  expect(requests).toBe(1);
  const trace = readFileSync(join(home, "mcp-trace.log"), "utf8");
  expect((trace.match(/provider\.blocked/g) ?? []).length).toBe(2);
});
