import { describe, expect, test } from "bun:test";
import { parseWsTurn, wsFrames } from "../src/ws-responses";

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
