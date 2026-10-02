// passthrough.test.ts — M2: el reenvio nativo funciona contra un upstream mock.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { createHandler } from "../src/server";
import { startServer } from "../src/server";

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  connection: string | null;
  custom: string | null;
  body: string;
}

const seen: Seen[] = [];
let mock: ReturnType<typeof Bun.serve>;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  mock = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : "";
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        auth: req.headers.get("authorization"),
        connection: req.headers.get("connection"),
        custom: req.headers.get("x-custom"),
        body,
      });
      if (url.pathname.endsWith("/models")) {
        if (url.searchParams.get("fail") === "1") {
          return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
        }
        return Response.json({ models: [{ slug: "gpt-5.6-sol" }] }, { headers: { "x-mock": "1" } });
      }
      if (url.pathname.endsWith("/responses")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"type":"response.output_text.delta","delta":"hola"}\n\n'));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "x-mock": "1" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${mock.port}/backend-api/codex`;
  server = startServer({ hostname: "127.0.0.1", port: 0, upstreamBase: base });
});

afterAll(() => {
  server.stop(true);
  mock.stop(true);
});

function ourUrl(path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

test("GET /v1/models reenvia auth, quita hop-by-hop y conserva status/headers", async () => {
  seen.length = 0;
  const res = await fetch(ourUrl("/v1/models?client_version=0.155.1"), {
    headers: { authorization: "Bearer test-token", connection: "x-hop-test", "x-custom": "1" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("x-mock")).toBe("1");
  const json = (await res.json()) as { models: Array<{ slug: string }> };
  expect(json.models[0].slug).toBe("gpt-5.6-sol");

  expect(seen).toHaveLength(1);
  expect(seen[0].method).toBe("GET");
  expect(seen[0].path).toBe("/backend-api/codex/models?client_version=0.155.1");
  expect(seen[0].auth).toBe("Bearer test-token");
  // El valor hop-by-hop del llamador no se reenvia (Bun agrega el suyo).
  expect(seen[0].connection).not.toBe("x-hop-test");
  expect(seen[0].custom).toBe("1");
});

test("POST /v1/responses hace streaming SSE y conserva el body", async () => {
  seen.length = 0;
  const payload = JSON.stringify({ model: "gpt-5.6", input: "hola" });
  const res = await fetch(ourUrl("/v1/responses"), {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: payload,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  expect(text).toContain('"response.output_text.delta"');
  expect(text).toContain("data: [DONE]");
  expect(seen[0].method).toBe("POST");
  expect(seen[0].path).toBe("/backend-api/codex/responses");
  expect(seen[0].body).toBe(payload);
});

test("status de error del upstream se propaga", async () => {
  const res = await fetch(ourUrl("/v1/models?fail=1"), {
    headers: { authorization: "Bearer test-token" },
  });
  expect(res.status).toBe(401);
});

test("rutas y metodos invalidos fallan con JSON nombrado", async () => {
  const notFound = await fetch(ourUrl("/v1/unknown"));
  expect(notFound.status).toBe(404);
  expect(((await notFound.json()) as { error: { type: string } }).error.type).toBe("not_found");

  const wrongMethod = await fetch(ourUrl("/v1/responses"));
  expect(wrongMethod.status).toBe(405);
  expect(((await wrongMethod.json()) as { error: { type: string } }).error.type).toBe("method_not_allowed");
});

test("upstream inalcanzable devuelve 502 nombrado, no excepcion", async () => {
  const dead: AppConfig = {
    hostname: "127.0.0.1",
    port: 0,
    upstreamBase: "http://127.0.0.1:1/backend-api/codex",
  };
  const handler = createHandler(dead);
  const res = await handler(
    new Request("http://127.0.0.1/v1/models", { headers: { authorization: "Bearer x" } }),
  );
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: { type: string } }).error.type).toBe("upstream_unreachable");
});

test("/health responde sin tocar el upstream", async () => {
  seen.length = 0;
  const res = await fetch(ourUrl("/health"));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { status: string }).status).toBe("ok");
  expect(seen).toHaveLength(0);
});
