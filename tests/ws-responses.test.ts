import { describe, expect, test } from "bun:test";
import { parseWsTurn, toJsonl, wsFrames } from "../src/ws-responses";

describe("websocket de Codex", () => {
  test("acepta el body de response.create", () => {
    const turn = parseWsTurn(JSON.stringify({
      type: "response.create",
      response: { model: "chatgpt-web/gpt-5.6-sol", input: "hola" },
    }));
    expect(turn?.web).toBe(true);
    expect(turn?.prompt).toBe("hola");
  });

  test("un slug nativo no se manda al browser", () => {
    expect(parseWsTurn(JSON.stringify({ model: "gpt-5.6", input: "x" }))?.web).toBe(false);
  });

  test("jsonl es una linea por evento, sin mandar el slug a la cuenta", () => {
    const body = toJsonl(wsFrames("chatgpt-web/gpt-5.6-sol", "ok").map((line) => JSON.parse(line)));
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(9);
    expect(JSON.parse(lines[0]).type).toBe("response.created");
    expect(body.endsWith("\n")).toBe(true);
  });

  test("secuencia Responses completa (la que el Codex CLI acepta)", () => {
    const frames = wsFrames("chatgpt-web/gpt-6.1-sol", "ok").map((f) => JSON.parse(f) as { type: string; sequence_number: number });
    expect(frames.map((f) => f.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(frames.map((f) => f.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("el delta llega DESPUES de anunciar su item y con el mismo item_id (gate M8)", () => {
    // Bug real: sin output_item.added el Codex CLI logueaba
    // "OutputTextDelta without active item" y no mostraba la respuesta.
    const frames = wsFrames("chatgpt-web/gpt-5.6-sol", "PONG").map((f) => JSON.parse(f) as Record<string, any>);
    const added = frames.findIndex((f) => f.type === "response.output_item.added");
    const delta = frames.findIndex((f) => f.type === "response.output_text.delta");
    expect(added).toBeGreaterThanOrEqual(0);
    expect(added).toBeLessThan(delta);
    expect(frames[delta]!.item_id).toBe(frames[added]!.item.id);
    expect(frames[delta]!.delta).toBe("PONG");
    expect(frames.at(-1)!.response.output_text).toBe("PONG");
  });
});


test("real WebSocket uses task identity preflight instead of the default session", async () => {
  const { startServer } = await import("../src/server");
  const { loadConfig } = await import("../src/config");
  const server = startServer(loadConfig({ CODEX_WEB_HTTP_PORT: "0", CODEX_WEB_HTTP_WEB_MODELS: "on" }));
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/responses`);
  let timer: ReturnType<typeof setTimeout>;
  try {
    const event = await new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("missing identity preflight")), 1500);
      ws.onopen = () => ws.send(JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: "hello" }));
      ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
      ws.onerror = () => reject(new Error("socket failed"));
    });
    expect(event).toMatchObject({ type: "error", error: { type: "web_task_identity_missing" } });
  } finally { clearTimeout(timer!); ws.close(); server.stop(true); }
});

test("Web compaction is rejected before native forwarding", async () => {
  const { createHandler } = await import("../src/server");
  const { loadConfig } = await import("../src/config");
  const response = await createHandler(loadConfig())(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: "hello" }),
  }));
  expect(response.status).toBe(400);
  expect((await response.json()).error.type).toBe("web_compaction_unsupported");
});
