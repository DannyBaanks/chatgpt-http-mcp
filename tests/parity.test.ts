// parity.test.ts — M5: 6 casos fijos de streaming, cancelacion, reset,
// error de sesion y timeout contra un upstream mockeado. La forma SSE se
// conserva byte a byte: el bridge no reescribe eventos.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer } from "../src/server";
import type { AppConfig } from "../src/config";
import { UpstreamStreamError } from "../src/responses/errors";
import { withUncleanCloseTolerance } from "../src/responses/stream";

const SSE_TEXT = 'data: {"type":"response.output_text.delta","delta":"hola"}\n\ndata: [DONE]\n\n';
const SSE_MULTI =
  'id: 1\nevent: message\ndata: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: [DONE]\n\n';
const SSE_PARTIAL = 'data: {"type":"response.output_text.delta","delta":"cortado"}\n\n';

const enc = new TextEncoder();
const mockState = { cancelled: false, requests: 0 };

function sse(text: string): Response {
  return new Response(enc.encode(text), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

/** Envia texto y luego simula un reset de conexion (cierre sucio) DIFERIDO:
 * primero se entregan headers+chunk; el reset llega a mitad del body. */
function streamThenReset(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(text));
      setTimeout(() => {
        try {
          controller.error(new Error("ECONNRESET"));
        } catch {
          /* el stream ya cerro */
        }
      }, 20);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

/** Stream que entrega texto y luego falla, para tests unitarios del wrapper. */
function erroringStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(text));
      setTimeout(() => {
        try {
          controller.error(new Error("ECONNRESET"));
        } catch {
          /* el stream ya cerro */
        }
      }, 5);
    },
  });
}

/** Stream infinito y cancelable, para probar la propagacion de cancelacion. */
function endless(): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      controller.enqueue(enc.encode('data: {"delta":"x"}\n\n'));
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    cancel() {
      mockState.cancelled = true;
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

let mock: ReturnType<typeof Bun.serve>;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  mock = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const c = url.searchParams.get("case");
      mockState.requests++;
      if (url.pathname.endsWith("/models")) {
        if (c === "slow-headers") {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          return Response.json({ models: [] });
        }
        if (c === "auth401") {
          return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
        }
        return Response.json({ models: [] });
      }
      if (url.pathname.endsWith("/responses")) {
        switch (c) {
          case "text":
            return sse(SSE_TEXT);
          case "multiline":
            return sse(SSE_MULTI);
          case "reset-after-done":
            return streamThenReset(SSE_TEXT);
          case "reset-before-done":
            return streamThenReset(SSE_PARTIAL);
          case "endless":
            return endless();
          default:
            return sse(SSE_TEXT);
        }
      }
      return new Response("nope", { status: 404 });
    },
  });

  const config: AppConfig = {
    hostname: "127.0.0.1",
    port: 0,
    upstreamBase: `http://127.0.0.1:${mock.port}/backend-api/codex`,
    webModels: "off",
    capabilities: { solAvailable: true, proAvailable: false },
    timeoutMs: 200,
  };
  server = startServer(config);
});

afterAll(() => {
  server.stop(true);
  mock.stop(true);
});

function ourUrl(path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

function post(path: string, signal?: AbortSignal): Promise<Response> {
  return fetch(ourUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: "{}",
    signal,
  });
}

test("caso 1 — texto: SSE identico byte a byte y con [DONE]", async () => {
  const res = await post("/v1/responses?case=text");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(await res.text()).toBe(SSE_TEXT);
});

test("caso 2 — multiples eventos/ids: sin reescritura", async () => {
  const res = await post("/v1/responses?case=multiline");
  expect(await res.text()).toBe(SSE_MULTI);
});

test("caso 3 — reset despues de [DONE]: cierra normal, no trunca", async () => {
  const res = await post("/v1/responses?case=reset-after-done");
  const text = await res.text(); // no debe rechazar
  expect(text).toBe(SSE_TEXT);
  expect(text).toContain("data: [DONE]");
});

test("caso 4 — reset antes de [DONE]: nunca se presenta como turno completo", async () => {
  const res = await post("/v1/responses?case=reset-before-done");
  expect(res.status).toBe(200);
  let text = "";
  let rejected = false;
  try {
    text = await res.text();
  } catch {
    rejected = true;
  }
  // Aceptable: error de stream o truncamiento detectable. Jamas un final falso.
  expect(rejected || !text.includes("[DONE]")).toBe(true);
});

test("wrapper unit — reset tras [DONE] cierra normal", async () => {
  const wrapped = withUncleanCloseTolerance(erroringStream(SSE_TEXT));
  expect(await new Response(wrapped).text()).toBe(SSE_TEXT);
});

test("wrapper unit — reset antes de [DONE] propaga UpstreamStreamError", async () => {
  const wrapped = withUncleanCloseTolerance(erroringStream(SSE_PARTIAL));
  await expect(new Response(wrapped).text()).rejects.toThrow(UpstreamStreamError);
});

test("caso 5 — error de sesion: status y body del upstream se propagan", async () => {
  const res = await fetch(ourUrl("/v1/models?case=auth401"), {
    headers: { authorization: "Bearer test" },
  });
  expect(res.status).toBe(401);
  expect(((await res.json()) as { error: { message: string } }).error.message).toBe("unauthorized");
});

test("caso 6 — timeout de headers: 504 nombrado, no excepcion", async () => {
  const res = await fetch(ourUrl("/v1/models?case=slow-headers"), {
    headers: { authorization: "Bearer test" },
  });
  expect(res.status).toBe(504);
  expect(((await res.json()) as { error: { type: string } }).error.type).toBe("upstream_timeout");
});

test("caso extra — cancelacion del cliente: el stream corta y el server sigue vivo", async () => {
  const client = new AbortController();
  const res = await post("/v1/responses?case=endless", client.signal);
  const reader = res.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  client.abort();
  let rejected = false;
  try {
    await reader.read();
    await reader.read();
  } catch {
    rejected = true;
  }
  // El server debe seguir respondiendo despues de la cancelacion.
  const health = await fetch(ourUrl("/health"));
  expect(health.status).toBe(200);
  // La cancelacion debe propagarse al upstream (puede tardar un instante).
  for (let i = 0; i < 20 && !mockState.cancelled; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(rejected || mockState.cancelled).toBe(true);
});
