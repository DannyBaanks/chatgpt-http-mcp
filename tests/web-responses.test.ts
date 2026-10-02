import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildResponseBody,
  buildWebStream,
  extractPrompt,
  isWebModel,
} from "../src/web-responses";
import { mergeWebRows } from "../scripts/install-web-models";
import { parseCapabilities } from "../src/config";

describe("isWebModel", () => {
  test("solo el prefijo chatgpt-web/ es web", () => {
    expect(isWebModel("chatgpt-web/gpt-5.6-sol")).toBe(true);
    expect(isWebModel("gpt-5.6")).toBe(false);
    expect(isWebModel(undefined)).toBe(false);
    expect(isWebModel(42)).toBe(false);
  });
});

describe("extractPrompt", () => {
  test("input como string", () => {
    expect(extractPrompt({ input: "hola" })).toBe("hola");
  });

  test("instructions se antepone", () => {
    expect(extractPrompt({ instructions: "eres util", input: "hola" })).toBe("eres util\n\nhola");
  });

  test("items de mensaje: el eco del usuario se omite, el asistente se queda", () => {
    const prompt = extractPrompt({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "mi turno" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "contexto previo" }] },
      ],
    });
    expect(prompt).toBe("contexto previo");
  });

  test("input_text plano sin content", () => {
    expect(extractPrompt({ input: [{ type: "input_text", text: "directo" }] })).toBe("directo");
  });
});

describe("buildResponseBody", () => {
  const body = buildResponseBody("chatgpt-web/gpt-5.6-sol", "respuesta completa", "el prompt");

  test("contrato object/status", () => {
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.model).toBe("chatgpt-web/gpt-5.6-sol");
  });

  test("output[0] es message assistant con output_text", () => {
    const output = body.output as Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }>;
    expect(output[0].type).toBe("message");
    expect(output[0].role).toBe("assistant");
    expect(output[0].content[0].type).toBe("output_text");
    expect(output[0].content[0].text).toBe("respuesta completa");
  });

  test("usage cuadra (estimado, pero consistente)", () => {
    const usage = body.usage as { input_tokens: number; output_tokens: number; total_tokens: number };
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens);
  });

  test("cada respuesta tiene id propio", () => {
    expect(buildResponseBody("m", "a", "b").id).not.toBe(buildResponseBody("m", "a", "b").id);
  });
});

describe("buildWebStream", () => {
  test("emite created, delta, done, completed y [DONE] en orden", async () => {
    const stream = buildWebStream("chatgpt-web/gpt-5.6-sol", "texto", "prompt");
    const text = await new Response(stream).text();
    const order = ["response.created", "response.output_text.delta", "response.output_text.done", "response.completed", "[DONE]"];
    let cursor = -1;
    for (const marker of order) {
      const at = text.indexOf(marker);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("el delta lleva el texto completo (fuente no incremental)", async () => {
    const text = await new Response(buildWebStream("m", "texto completo", "p")).text();
    const delta = /event: response\.output_text\.delta\ndata: (.+)\n\n/.exec(text);
    expect(JSON.parse(delta![1]).delta).toBe("texto completo");
  });
});

describe("mergeWebRows", () => {
  const caps = parseCapabilities("sol,pro,extrahigh,bigger");
  // Template nativo real del fixture del repo: augmentCatalog exige una fila
  // list-visible con reasoning levels para clonar las Web. Un cache de prueba
  // minimo no alcanza — por eso se usa el fixture, no un stub.
  const nativeFixture = JSON.parse(
    readFileSync(new URL("../fixtures/native-models.sample.json", import.meta.url), "utf8"),
  ) as { models: Array<Record<string, unknown>> };
  const template = nativeFixture.models[0];

  test("agrega filas web y conserva las nativas", () => {
    const cache = { models: [{ slug: "chatgpt-web/viejo" }, { ...template }] };
    const merged = mergeWebRows(cache, caps);
    expect(merged.kept).toBe(1);
    expect(merged.models.some((m) => (m as { slug: string }).slug === template.slug)).toBe(true);
    expect(merged.added.length).toBeGreaterThan(0);
  });

  test("idempotente: dos merges no duplican filas web", () => {
    const once = mergeWebRows({ models: [{ ...template }] }, caps);
    const twice = mergeWebRows({ models: once.models }, caps);
    expect(twice.models.length).toBe(once.models.length);
    expect(twice.added.sort()).toEqual(once.added.sort());
  });

  test("no toca filas nativas existentes (mismo objeto)", () => {
    const merged = mergeWebRows({ models: [{ ...template }] }, caps);
    expect(merged.models[0]).toEqual(template);
    expect(merged.kept).toBe(1);
  });

  test("sin cache no tira: la ruta se instala igual", () => {
    const merged = mergeWebRows({ models: [] }, caps);
    expect(merged.kept).toBe(0);
    expect(merged.added.length).toBeGreaterThan(0);
  });

  test("saca las filas web viejas antes de agregar las nuevas", () => {
    const merged = mergeWebRows({ models: [{ slug: "chatgpt-web/viejo" }, { ...template }] }, caps);
    expect(merged.models.some((m) => (m as { slug: string }).slug === "chatgpt-web/viejo")).toBe(false);
  });
});