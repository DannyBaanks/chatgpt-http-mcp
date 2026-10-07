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
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0]).type).toBe("response.created");
    expect(body.endsWith("\n")).toBe(true);
  });

  test("los frames no usan el slug contra la cuenta de ChatGPT", () => {
    const frames = wsFrames("chatgpt-web/gpt-6.1-sol", "ok").map((f) => JSON.parse(f) as { type: string });
    expect(frames.map((f) => f.type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.output_text.done",
      "response.completed",
    ]);
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
