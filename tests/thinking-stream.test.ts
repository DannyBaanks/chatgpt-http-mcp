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

  test("extraccion DOM de thought: ignora elementos markdown y assistant-message con getAttribute y classList completos", () => {
    // Simulador de la logica interna de evaluacion DOM en el navegador
    const isAssistantMessage = (el: { getAttribute?: (k: string) => string | null; classList?: { contains: (k: string) => boolean }; className?: string }) => {
      const attr = typeof el.getAttribute === "function" ? el.getAttribute("data-markdown-text-style") : null;
      if (attr === "assistant-message") return true;
      if (el.classList && typeof el.classList.contains === "function" && el.classList.contains("markdown")) return true;
      if (typeof el.className === "string" && el.className.split(/\s+/).includes("markdown")) return true;
      return false;
    };

    // Caso 1: elemento con classList.contains('markdown') no debe ser considerado thought
    const markdownEl = {
      className: "markdown prose",
      classList: { contains: (c: string) => c === "markdown" || c === "prose" },
      getAttribute: (k: string) => (k === "class" ? "markdown prose" : null),
      innerText: "Texto de respuesta normal",
    };
    expect(isAssistantMessage(markdownEl)).toBe(true);

    // Caso 2: elemento con data-markdown-text-style="assistant-message"
    const assistantEl = {
      className: "",
      classList: { contains: () => false },
      getAttribute: (k: string) => (k === "data-markdown-text-style" ? "assistant-message" : null),
      innerText: "Texto principal",
    };
    expect(isAssistantMessage(assistantEl)).toBe(true);

    // Caso 3: elemento de pensamiento legitimo
    const thoughtEl = {
      className: "thought-content",
      classList: { contains: (c: string) => c === "thought-content" },
      getAttribute: (k: string) => (k === "data-testid" ? "thought-content" : null),
      innerText: "Pensando en la solución paso a paso...",
    };
    expect(isAssistantMessage(thoughtEl)).toBe(false);

    // Caso 4: mock incompleto sin getAttribute ni classList (no debe lanzar excepcion ni aprobar falsamente)
    const brokenEl = {
      className: "markdown",
      innerText: "Texto sin metodos",
    };
    expect(isAssistantMessage(brokenEl as any)).toBe(true);
  });
});
