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
      if (item.type !== undefined && item.type !== "message") return unsupported("input item is not supported by the Web Responses adapter");
      if (!["user", "assistant", "developer", "system"].includes(item.role as string)) return invalid("message role must be user, assistant, developer or system");
      const text = contentText(item.content);
      return text.trim() ? `[${item.role}]\n${text}` : "";
    }).filter(Boolean).join("\n\n");
  } else return invalid("input must be text or an array of structured items");
  if (!turn.trim()) throw new ResponsesInputError("web_empty_input", "no usable message text in input");
  return { prompt: instructions ? `${instructions}\n\n${turn}` : turn, declarations };
}
