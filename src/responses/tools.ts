import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { WebTaskError } from "./selection";

const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (detail: string): never => { throw new WebTaskError("web_tool_protocol_invalid", 502, detail); };
export interface NativeTool {
  wireName: string;
  name: string;
  namespace?: string;
  type: "function" | "custom";
  declaration: Record<string, any>;
}
export type NativeCall = {
  type: "function_call" | "custom_tool_call";
  call_id: string;
  name: string;
  namespace?: string;
  arguments?: string;
  input?: string;
};
export type NativeToolChoice = "auto" | "none";

/** Unsupported caller policies must fail before a Web submission. */
export function nativeToolChoice(value: unknown): NativeToolChoice {
  if (value === undefined || value === "auto") return "auto";
  if (value === "none") return "none";
  throw new WebTaskError("web_tool_choice_unsupported", 400, "this adapter supports only tool_choice auto or none");
}

/** The client supplies the registry. This module never executes a tool. */
export function nativeTools(declarations: Record<string, any>[]): Map<string, NativeTool> {
  const registry = new Map<string, NativeTool>();
  function add(list: unknown, namespace?: string) {
    if (!Array.isArray(list)) throw new WebTaskError("web_tool_declaration_invalid", 400, "namespace tools must be an array");
    for (const item of list) {
      if (!object(item)) throw new WebTaskError("web_tool_declaration_invalid", 400, "tool declaration must be an object");
      if (item.type === "namespace") {
        if (namespace || typeof item.name !== "string" || !/^[\w-]+$/.test(item.name))
          throw new WebTaskError("web_tool_declaration_invalid", 400, "invalid or nested tool namespace");
        add(item.tools, item.name); continue;
      }
      const d = item.type === "function" && object(item.function) ? item.function : item;
      if (!["function", "custom"].includes(item.type) || typeof d.name !== "string" || !/^[\w.-]+$/.test(d.name))
        throw new WebTaskError("web_tool_declaration_unsupported", 400, "only supplied function/custom tools are supported");
      const wireName = namespace ? `${namespace}.${d.name}` : d.name;
      if (registry.has(wireName)) throw new WebTaskError("web_tool_declaration_invalid", 400, "duplicate tool name");
      if (item.type === "function" && !object(d.parameters))
        throw new WebTaskError("web_tool_declaration_invalid", 400, `missing JSON schema for ${wireName}`);
      registry.set(wireName, { wireName, name: d.name, namespace, type: item.type, declaration: d });
    }
  }
  add(declarations);
  return registry;
}

function schema(tool: NativeTool) {
  return { tool: tool.wireName, type: tool.type, description: tool.declaration.description ?? "",
    ...(tool.type === "function" ? { parameters: tool.declaration.parameters } : { format: tool.declaration.format ?? { type: "text" } }) };
}

export function toolSchemas(registry: Map<string, NativeTool>, names: unknown): string {
  if (!Array.isArray(names) || names.length < 1 || names.length > 4 || names.some(n => typeof n !== "string" || !registry.has(n)))
    return fail("describe_tools requires one to four exact registered names");
  const text = JSON.stringify(names.map(n => schema(registry.get(n)!)));
  if (text.length > 128_000) return fail("requested tool schema exceeds the explicit transport budget");
  return text;
}

/** Large registries are indexed; exact non-core schemas can be requested. */
export function toolPrompt(registry: Map<string, NativeTool>, choice: NativeToolChoice = "auto"): string {
  if (!registry.size) return "";
  if (choice === "none") return `ISyMCP CODEX RESPONSE CONTRACT\nThe caller selected tool_choice=none. Tools and schema requests are disabled for this response. Reply with exactly ONE JSON object: {"kind":"final","text":"your answer"}, optionally inside one json code fence. Do not execute through ChatGPT apps or invent tool results.\nEND CODEX RESPONSE CONTRACT\n\n`;
  const directory = JSON.stringify([...registry.values()].map(t => ({ tool: t.wireName, type: t.type })));
  if (directory.length > 200_000) throw new WebTaskError("web_tool_registry_too_large", 400, "tool directory exceeds transport budget");
  const core = [...registry.values()].filter(t => /^(?:functions\.)?(exec|exec_command|shell|shell_command|write_stdin|apply_patch|view_image)$/.test(t.wireName));
  let initial = JSON.stringify(core.map(schema));
  if (initial.length > 128_000) initial = "[]";
  return `ISyMCP CODEX RESPONSE CONTRACT\nYou are the reasoning model of an outer Codex task. Codex executes tools and owns its sandbox, approvals and process sessions. Reply with exactly ONE JSON object, optionally inside one json code fence. No other prose outside it.\nFor a final answer: {"kind":"final","text":"your answer"}.\nFor one native function call: {"kind":"call","tool":"exact registered name","arguments":{...}}. For one native custom tool: {"kind":"call","tool":"exact registered name","input":"exact freeform input"}. Do not execute through ChatGPT apps or invent tool results. Wait for the next message containing the real Codex result before reporting success. Nonzero exits and denials remain failures.\nTo obtain exact schemas for other registered tools first: {"kind":"describe_tools","names":["exact name"]}. Only one native call per response; later calls can follow its result.\nTool directory (every name provided by this client):\n${directory}\nInitial exact schemas:\n${initial}\nEND CODEX RESPONSE CONTRACT\n\n`;
}

export type ToolReply = { kind: "final"; text: string } | { kind: "call"; call: NativeCall } | { kind: "describe_tools"; schemas: string };
export function decodeToolReply(text: string, registry: Map<string, NativeTool>, choice: NativeToolChoice = "auto"): ToolReply {
  const trimmed = text.trim();
  const source = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)?.[1] ?? trimmed;
  let reply: any;
  try { reply = JSON.parse(source); } catch { return fail("Web reply is not one JSON response object"); }
  if (!object(reply)) return fail("parallel/array replies are not supported");
  if (reply.kind === "final" && typeof reply.text === "string" && reply.text.trim()) return { kind: "final", text: reply.text };
  if (choice === "none") return fail("tool_choice none requires a final answer without a native call or schema request");
  if (reply.kind === "describe_tools") return { kind: "describe_tools", schemas: toolSchemas(registry, reply.names) };
  if (reply.kind !== "call" || typeof reply.tool !== "string") return fail("invalid response kind");
  const tool = registry.get(reply.tool);
  if (!tool) return fail("requested tool is not in this Codex registry");
  const base = { call_id: `call_isymcp_${crypto.randomUUID().replace(/-/g, "")}`, name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}) };
  if (tool.type === "custom") {
    if (typeof reply.input !== "string" || !reply.input.trim() || reply.input.length > 128_000 || reply.arguments !== undefined)
      return fail("custom call requires bounded freeform input");
    return { kind: "call", call: { ...base, type: "custom_tool_call", input: reply.input } };
  }
  if (!object(reply.arguments) || reply.input !== undefined) return fail("function call requires an arguments object");
  try {
    const checked = new AjvJsonSchemaValidator().getValidator(tool.declaration.parameters)(reply.arguments);
    if (!checked.valid) return fail(`arguments do not match the supplied schema: ${checked.errorMessage}`);
  } catch (error) {
    if (error instanceof WebTaskError) throw error;
    return fail("supplied tool schema could not be validated");
  }
  return { kind: "call", call: { ...base, type: "function_call", arguments: JSON.stringify(reply.arguments) } };
}
