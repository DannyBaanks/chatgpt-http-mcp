import { describe, expect, test } from "bun:test";
import {
  buildChatCompletion,
  buildChatStream,
  chatBodyToWebRequest,
} from "../src/chat-completions";

describe("chatBodyToWebRequest", () => {
  test("system va al frente y user/assistant como transcript", () => {
    const web = chatBodyToWebRequest({
      model: "chatgpt-web/gpt-5.6-sol-instant",
      messages: [
        { role: "system", content: "eres util" },
        { role: "user", content: "hola" },
      ],
    });
    expect(web?.prompt).toBe("eres util\n\nuser: hola");
    expect(web?.stream).toBe(false);
  });

  test("stream se propaga y content por partes se une", () => {
    const web = chatBodyToWebRequest({
      model: "chatgpt-web/gpt-5.6-sol",
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
    });
    expect(web?.prompt).toBe("user: ab");
    expect(web?.stream).toBe(true);
  });

  test("modelo ajeno o sin texto falla cerrado", () => {
    expect(chatBodyToWebRequest({ model: "gpt-5.6", messages: [{ role: "user", content: "hola" }] })).toBeNull();
    expect(chatBodyToWebRequest({ model: "chatgpt-web/gpt-5.6-sol", messages: [] })).toBeNull();
    expect(chatBodyToWebRequest({ model: "chatgpt-web/gpt-5.6-sol" })).toBeNull();
    expect(chatBodyToWebRequest(null)).toBeNull();
  });
});

describe("buildChatCompletion", () => {
  test("contrato chat.completion con usage estimado", () => {
    const body = buildChatCompletion("chatgpt-web/gpt-5.6-sol-instant", "hola mundo", "di hola") as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    const choices = body.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("stop");
    expect((choices[0].message as Record<string, unknown>).content).toBe("hola mundo");
    const usage = body.usage as Record<string, number>;
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
  });
});

describe("buildChatStream", () => {
  test("un delta con el texto y luego [DONE]", async () => {
    const stream = buildChatStream("chatgpt-web/gpt-5.6-sol-instant", "hola");
    const text = await new Response(stream).text();
    expect(text).toContain('"delta":{"role":"assistant","content":"hola"}');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});
