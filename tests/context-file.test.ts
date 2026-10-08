import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_SLICE_MAX_BYTES, makeContextKey, parseReadCall, readContextSlice,
  renderContextContract, renderReadResult, writeContextFile,
} from "../src/context-file";

test("context key is stable and conversation-specific", () => {
  const a = makeContextKey("chatgpt-web/gpt-5.6-sol", "sys", "hola");
  expect(a).toBe(makeContextKey("chatgpt-web/gpt-5.6-sol", "sys", "hola"));
  expect(a).not.toBe(makeContextKey("chatgpt-web/gpt-5.6-sol", "sys", "otro"));
  expect(a).toMatch(/^[a-f0-9]{12}$/);
});

test("write + read slice by lines with byte cap", () => {
  process.env.CODEX_WEB_HTTP_CONTEXT_DIR = mkdtempSync(join(tmpdir(), "ctx-"));
  const text = Array.from({ length: 500 }, (_, i) => `linea ${i} ${"x".repeat(30)}`).join("\n");
  const { path, total } = writeContextFile("abc123abc123", text);
  expect(total).toBe(500);
  const first = readContextSlice(path, 0, 200);
  expect(first.offset).toBe(0);
  expect(first.next).toBeLessThanOrEqual(200);
  expect(first.total).toBe(500);
  const second = readContextSlice(path, first.next, 200);
  expect(second.offset).toBe(first.next);
  expect(Buffer.byteLength(second.content, "utf8")).toBeLessThanOrEqual(CONTEXT_SLICE_MAX_BYTES);
  const big = readContextSlice(path, 0, 99999);
  expect(big.next - big.offset).toBeLessThanOrEqual(400);
});

test("read refuses paths outside the context dir", () => {
  process.env.CODEX_WEB_HTTP_CONTEXT_DIR = mkdtempSync(join(tmpdir(), "ctx-"));
  expect(() => readContextSlice("/etc/passwd", 0, 10)).toThrow(/fuera del contexto/);
});

test("parseReadCall accepts direct, fenced and object arguments", () => {
  const direct = '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"/tmp/x.txt\\",\\"offset\\":10,\\"limit\\":20}"}}]}';
  expect(parseReadCall(direct)).toEqual({ path: "/tmp/x.txt", offset: 10, limit: 20 });
  expect(parseReadCall("```json\n" + direct + "\n```")).toEqual({ path: "/tmp/x.txt", offset: 10, limit: 20 });
  const objArgs = '{"tool_calls":[{"function":{"name":"read","arguments":{"path":"/tmp/y.txt"}}}]}';
  expect(parseReadCall(objArgs)).toEqual({ path: "/tmp/y.txt", offset: 0, limit: 200 });
});

test("parseReadCall rejects non-read replies and junk", () => {
  expect(parseReadCall("ACK")).toBeNull();
  expect(parseReadCall('{"tool_calls":[{"function":{"name":"write","arguments":"{}"}}]}')).toBeNull();
  expect(parseReadCall('{"tool_calls":[]}')).toBeNull();
  expect(parseReadCall("no json")).toBeNull();
});

test("contract and result carry the essentials", () => {
  const contract = renderContextContract("/tmp/ctx.txt", 400, 0);
  expect(contract).toContain("/tmp/ctx.txt");
  expect(contract).toContain("ACK");
  const result = renderReadResult({ path: "/tmp/ctx.txt", content: "x", offset: 0, next: 1, total: 2 });
  expect(result).toContain("next=1");
  expect(result).toContain("total=2");
});

test("compactContextText poda el cuerpo intermedio en textos gigantes", async () => {
  const { compactContextText } = await import("../src/context-file");
  const hugeText = Array.from({ length: 600 }, (_, i) => `Línea de log/código ${i + 1}`).join("\n");
  const result = compactContextText(hugeText, { maxLines: 200, keepHeadLines: 20, keepTailLines: 50 });

  expect(result.compacted).toBe(true);
  expect(result.originalLines).toBe(600);
  expect(result.finalLines).toBe(71);
  expect(result.text).toContain("Contexto podado");
  expect(result.text.startsWith("Línea de log/código 1\n")).toBe(true);
  expect(result.text.endsWith("Línea de log/código 600")).toBe(true);
});

