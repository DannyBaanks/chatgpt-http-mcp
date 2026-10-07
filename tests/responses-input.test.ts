import { expect, test } from "bun:test";
import { createHandler, startServer } from "../src/server";
import { loadConfig } from "../src/config";
import { parseWsTurn } from "../src/ws-responses";
import { extractPrompt, peekWebRequest } from "../src/web-responses";

const user = (content: unknown) => ({ type: "message", role: "user", content });
const text = (value: string) => ({ type: "input_text", text: value });
const request = (input: unknown) => new Request("http://127.0.0.1/v1/responses", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input }),
});

test("user-only Responses preserves the new instruction", async () => {
  const input = [user([text("M7_USER_NONCE")])];
  expect(extractPrompt({ input })).toBe("[user]\nM7_USER_NONCE");
  expect((await peekWebRequest(request(input)))?.prompt).toBe("[user]\nM7_USER_NONCE");
});
test("instructions precede text and structured roles retain order", () => {
  expect(extractPrompt({ input: "  exact\ntext  " })).toBe("  exact\ntext  ");
  expect(extractPrompt({ instructions: "RULE", input: [
    { type: "message", role: "developer", content: [text("constraint")] },
    user([text("first"), text("second")]),
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "history" }] },
  ] })).toBe("RULE\n\n[developer]\nconstraint\n\n[user]\nfirstsecond\n\n[assistant]\nhistory");
  expect(extractPrompt({ input: [{ type: "input_text", text: "direct" }] })).toBe("direct");
});

for (const input of [undefined, null, 7, {}, [null], [user([text("ok"), { type: "input_text", text: 7 }])], [user(7)]]) {
  test(`malformed input fails without losing content: ${JSON.stringify(input)}`, () => {
    expect(() => extractPrompt({ input })).toThrow("web_invalid_input");
  });
}
for (const item of [
  user([text("do not submit this partial text"), { type: "input_image", image_url: "data:image/png;base64,AA==" }]),
  { type: "future_item", text: "must not disappear" },
  { type: "function_call_output", call_id: "call1", output: "result" },
  { type: "custom_tool_call_output", call_id: "call1", output: "result" },
]) {
  test(`unsupported item is explicit: ${item.type}`, () => {
    expect(() => extractPrompt({ input: [item] })).toThrow("web_unsupported_input");
  });
}
for (const input of ["", "  ", [], [user([text("")])]]) {
  test(`empty input stays an honest typed error: ${JSON.stringify(input)}`, () => {
    expect(() => extractPrompt({ instructions: "not a user turn", input })).toThrow("web_empty_input");
  });
}
test("observed additional_tools namespace/custom declarations stay separate and ordered", async () => {
  const declarations = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "CODE_ONLY" }] },
    { type: "function", name: "second", parameters: { type: "object" } }];
  const input = [{ type: "additional_tools", role: "developer", tools: declarations }, user([text("hello")])];
  const parsed = await peekWebRequest(request(input));
  expect(parsed?.prompt).toBe("[user]\nhello");
  expect((parsed as any)?.declarations).toEqual(declarations);
  expect(parsed?.prompt).not.toContain("CODE_ONLY");
  expect(() => extractPrompt({ input: [{ type: "additional_tools", tools: [null] }, user("ok")] })).toThrow("web_invalid_input");
});

const config = () => loadConfig({ CODEX_WEB_HTTP_PORT: "0", CODEX_WEB_HTTP_WEB_MODELS: "on", CODEX_WEB_HTTP_STATE_PATH: "/nonexistent/M7-no-browser-state.json" });
for (const input of [[user([text("partial"), { type: "input_image", image_url: "untransported" }])], [user(7)]]) {
  test("real HTTP handler rejects unsupported/malformed input before browser submission", async () => {
    const res = await createHandler(config())(request(input));
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe(input[0].content === 7 ? "web_invalid_input" : "web_unsupported_input");
  });
}
test("HTTP native input stays untouched even when Web parser cannot handle it", async () => {
  const body = { model: "native-fixture", input: [{ type: "future_native_item", data: "preserved" }] };
  const upstream = Bun.serve({ port: 0, fetch: async (req) => Response.json(await req.json()) });
  try {
    const res = await createHandler({ ...config(), upstreamBase: `http://127.0.0.1:${upstream.port}` })(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect(await res.json()).toEqual(body);
  } finally { upstream.stop(true); }
});
test("WebSocket structured user input preserves text and declarations", () => {
  const declarations = [{ type: "custom", name: "exec" }];
  const parsed = parseWsTurn(JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: [{ type: "additional_tools", tools: declarations }, user([text("WS_NONCE")])] }));
  expect(parsed?.prompt).toBe("[user]\nWS_NONCE");
  expect((parsed as any)?.declarations).toEqual(declarations);
  expect(parseWsTurn(JSON.stringify({ model: "native-fixture", input: [{ type: "unknown-native" }] }))?.web).toBe(false);
});
test("real WebSocket returns typed validation error without launching a browser", async () => {
  const server = startServer(config());
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/responses`);
  let timer: ReturnType<typeof setTimeout>;
  try {
    const result = await new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("missing typed validation event")), 1500);
      ws.onopen = () => ws.send(JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: [user([{ type: "input_image", image_url: "ignored" }])] }));
      ws.onmessage = (event) => resolve(JSON.parse(String(event.data)));
      ws.onerror = () => reject(new Error("websocket connection failed"));
    });
    expect(result).toMatchObject({ type: "error", error: { type: "web_unsupported_input" } });
  } finally { clearTimeout(timer!); ws.close(); server.stop(true); }
});
