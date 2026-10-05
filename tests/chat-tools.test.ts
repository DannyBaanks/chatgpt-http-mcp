import { expect, test } from "bun:test";
import {
  parseToolCalls, readAssistantToolCalls, readTools, renderToolContract, toolNames,
} from "../src/chat-tools";

const TOOLS = [{ type: "function", function: { name: "get_time", description: "hora", parameters: { type: "object", properties: {} } } }];

test("readTools extrae tools OpenAI y descarta basura", () => {
  const tools = readTools(TOOLS);
  expect(tools).toEqual([{ name: "get_time", description: "hora", parameters: { type: "object", properties: {} } }]);
  expect(readTools(undefined)).toEqual([]);
  expect(readTools([{ function: { name: "" } }, "x", 1, null])).toEqual([]);
  expect([...toolNames(tools)]).toEqual(["get_time"]);
});

test("renderToolContract incluye protocolo y esquemas", () => {
  const c = renderToolContract(readTools(TOOLS));
  expect(c).toContain("PROTOCOLO DE FUNCIONES EXTERNAS");
  expect(c).toContain("get_time");
  expect(c).toContain("tool_calls");
  expect(c).toContain("Nunca digas que no tienes acceso");
});

test("parseToolCalls acepta directo, cerca y argumentos objeto; rechaza desconocidas", () => {
  const allowed = new Set(["get_time", "read_file"]);
  const direct = '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_time","arguments":"{}"}}]}';
  expect(parseToolCalls(direct, allowed)).toEqual([
    { id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } },
  ]);
  expect(parseToolCalls("```json\n" + direct + "\n```", allowed).length).toBe(1);
  expect(parseToolCalls('{"tool_calls":[{"function":{"name":"read_file","arguments":{"path":"/x"}}}]}', allowed)[0]!.function.arguments).toBe('{"path":"/x"}');
  expect(parseToolCalls('{"tool_calls":[{"function":{"name":"rm_rf","arguments":"{}"}}]}', allowed)).toEqual([]);
  expect(parseToolCalls("hola", allowed)).toEqual([]);
  expect(parseToolCalls('{"tool_calls":[]}', allowed)).toEqual([]);
});

test("readAssistantToolCalls serializa solo lo valido", () => {
  const calls = readAssistantToolCalls([{ id: "call_9", function: { name: "get_time", arguments: "{}" } }, null, { function: {} }]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.id).toBe("call_9");
  expect(readAssistantToolCalls(undefined)).toEqual([]);
});

test("parseToolCalls repara arguments con comillas sin escapar", () => {
  const broken = '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"isyco_read_context","arguments":"{"offset":0,"limit":83}"}}]}';
  const got = parseToolCalls(broken, new Set(["isyco_read_context"]));
  expect(got).toHaveLength(1);
  expect(JSON.parse(got[0]!.function.arguments)).toEqual({ offset: 0, limit: 83 });
});
