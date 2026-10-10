// Responses input is structured task state, not a local Web-chat transcript.
export class ResponsesInputError extends Error {
  readonly status = 400;
  constructor(readonly type: "web_invalid_input" | "web_unsupported_input" | "web_empty_input", detail: string) {
    super(`${type}: ${detail}`);
    this.name = "ResponsesInputError";
  }
}
export interface ParsedResponsesInput {
  prompt: string;
  /** Declarations only: preserving these does not implement a tool executor. */
  declarations: Record<string, unknown>[];
}
export type TaskInputItem = { role: string; text: string } | {
  type: "function_call" | "custom_tool_call" | "function_call_output" | "custom_tool_call_output" | "tool_search_call" | "tool_search_output";
  call_id: string; name?: string; namespace?: string; arguments?: string | Record<string, unknown>; input?: string; output?: string;
  execution?: "client"; tools?: Record<string, unknown>[];
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (detail: string): never => { throw new ResponsesInputError("web_invalid_input", detail); };
const unsupported = (detail: string): never => { throw new ResponsesInputError("web_unsupported_input", detail); };

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return invalid("message content must be text or text parts");
  return value.map((part) => {
    if (!record(part)) return invalid("content part must be an object");
    if (part.type !== "input_text" && part.type !== "output_text") return unsupported("content modality is not supported by the Web Responses adapter");
    if (typeof part.text !== "string") return invalid("text part must contain string text");
    return part.text;
  }).join("");
}

function toolItem(item: Record<string, unknown>): TaskInputItem | null {
  const type = item.type;
  if (!["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output", "tool_search_call", "tool_search_output"].includes(type as string)) return null;
  if (typeof item.call_id !== "string" || !item.call_id || item.call_id.length > 256) return invalid("tool item requires a bounded call_id");
  if (type === "tool_search_call" || type === "tool_search_output") {
    if (item.execution !== "client") return unsupported("only client-executed tool search is supported");
    if (type === "tool_search_call") {
      if (!record(item.arguments)) return invalid("client search requires object arguments");
      return { type, execution: "client", call_id: item.call_id, arguments: item.arguments };
    }
    if (!Array.isArray(item.tools) || !item.tools.every(record) || JSON.stringify(item.tools).length > 200_000)
      return invalid("client search output requires a bounded array of tool definitions");
    return { type, execution: "client", call_id: item.call_id, tools: item.tools };
  }
  if (String(type).endsWith("_output")) {
    return { type: type as "function_call_output", call_id: item.call_id, output: contentText(item.output) };
  }
  if (typeof item.name !== "string" || !item.name || (item.namespace !== undefined && typeof item.namespace !== "string"))
    return invalid("tool call requires an exact tool name");
  const field = type === "function_call" ? "arguments" : "input";
  if (typeof item[field] !== "string") return invalid(`tool call requires string ${field}`);
  return { type: type as "function_call", call_id: item.call_id, name: item.name,
    ...(item.namespace !== undefined ? { namespace: item.namespace as string } : {}), [field]: item[field] };
}

/** Transport IDs/status/channel do not change the committed semantic history. */
export function normalizeTaskInput(input: unknown): TaskInputItem[] {
  if (typeof input === "string") return [{ role: "user", text: input }];
  if (!Array.isArray(input)) return invalid("input must be text or an array");
  return input.filter(i => record(i) && i.type !== "additional_tools").map(item => {
    const tool = toolItem(item);
    if (tool) return tool;
    return { role: item.type === "input_text" ? "user" : item.role as string,
      text: item.type === "input_text" ? item.text as string : contentText(item.content) };
  });
}

export function parseResponsesInput(body: Record<string, unknown>): ParsedResponsesInput {
  if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== "string") invalid("instructions must be text");
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  const declarations: Record<string, unknown>[] = [];
  const addDeclarations = (value: unknown) => {
    if (!Array.isArray(value) || !value.every(record)) invalid("tool declarations must be an array of objects");
    declarations.push(...value as Record<string, unknown>[]);
  };
  if (body.tools !== undefined) addDeclarations(body.tools);
  let turn: string;
  if (typeof body.input === "string") turn = body.input;
  else if (Array.isArray(body.input)) {
    turn = body.input.map((item) => {
      if (!record(item)) return invalid("input item must be an object");
      if (item.type === "additional_tools") { addDeclarations(item.tools); return ""; }
      if (item.type === "input_text") {
        if (typeof item.text !== "string") return invalid("input_text must contain string text");
        return item.text;
      }
      const tool = toolItem(item);
      if (tool) {
        const { output, ...identity } = "type" in tool ? tool : { output: undefined, ...tool };
        return `[Codex tool evidence]\n${JSON.stringify(identity)}${output === undefined ? "" : `\n${output}`}`;
      }
      if (item.type !== undefined && item.type !== "message") return unsupported("input item is not supported by the Web Responses adapter");
      if (!["user", "assistant", "developer", "system"].includes(item.role as string)) return invalid("message role must be user, assistant, developer or system");
      const text = contentText(item.content);
      return text.trim() ? `[${item.role}]\n${text}` : "";
    }).filter(Boolean).join("\n\n");
  } else return invalid("input must be text or an array of structured items");
  if (!turn.trim()) throw new ResponsesInputError("web_empty_input", "no usable message text in input");
  return { prompt: instructions ? `${instructions}\n\n${turn}` : turn, declarations };
}
