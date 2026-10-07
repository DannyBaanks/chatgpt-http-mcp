import { expect, test } from "bun:test";
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
