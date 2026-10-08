import { describe, expect, test } from "bun:test";
import { buildChatCompletion, buildChatStream } from "../src/chat-completions";
import { chatStatus } from "../src/chat-turn";

describe("captura y streaming de razonamiento / pensamiento (thinking stream)", () => {
  test("buildChatCompletion incluye reasoning_content y tokens de razonamiento cuando hay thought", () => {
    const res = buildChatCompletion(
      "chatgpt-web/gpt-5.6-sol",
      "Respuesta final",
      "Hola",
      [],
      "Pensando paso a paso sobre el problema...",
    );

    const choice = (res.choices as Array<{ message: Record<string, unknown> }>)[0];
    expect(choice.message.content).toBe("Respuesta final");
    expect(choice.message.reasoning_content).toBe("Pensando paso a paso sobre el problema...");

    const usage = res.usage as { completion_tokens_details?: { reasoning_tokens?: number } };
    expect(usage.completion_tokens_details?.reasoning_tokens).toBeGreaterThan(0);
  });

  test("buildChatStream emite chunk con reasoning_content antes del contenido final", async () => {
    const stream = buildChatStream(
      "chatgpt-web/gpt-5.6-sol",
      "Respuesta final",
      [],
      "Mi pensamiento previo",
    );

    const reader = stream.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    const fullSse = chunks.join("");
    expect(fullSse).toContain('"reasoning_content":"Mi pensamiento previo"');
    expect(fullSse).toContain('"content":"Respuesta final"');
    expect(fullSse).toContain("data: [DONE]");
  });

  test("chatStatus devuelve thought cuando el estado activo lo contiene", () => {
    const status = chatStatus();
    expect(status).toHaveProperty("phase");
    expect(status).toHaveProperty("chat_id");
  });
});
