// chat-tools.ts — function calling para el transporte chat del bridge.
//
// ChatGPT Web no ejecuta herramientas, asi que le pedimos un sobre JSON
// estricto y lo traducimos al contrato OpenAI `tool_calls`; la TUI
// (ISyCode/opencode) las ejecuta con SUS permisos y devuelve los resultados
// como role:"tool". El bridge no ejecuta nada.

export interface ChatTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Extrae las tools del body chat.completions (formato OpenAI). */
export function readTools(value: unknown): ChatTool[] {
  if (!Array.isArray(value)) return [];
  const out: ChatTool[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const fn = (item as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object") continue;
    const f = fn as Record<string, unknown>;
    if (typeof f.name !== "string" || !f.name) continue;
    out.push({
      name: f.name,
      ...(typeof f.description === "string" ? { description: f.description } : {}),
      ...(f.parameters !== undefined ? { parameters: f.parameters } : {}),
    });
  }
  return out;
}

export function toolNames(tools: readonly ChatTool[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

/** tool_calls de un mensaje assistant del historial, validados por forma. */
export function readAssistantToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const out: ChatToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const fn = obj.function;
    if (!fn || typeof fn !== "object") continue;
    const f = fn as Record<string, unknown>;
    if (typeof f.name !== "string" || !f.name) continue;
    const args = typeof f.arguments === "string" ? f.arguments
      : f.arguments !== undefined ? JSON.stringify(f.arguments) : "{}";
    const id = typeof obj.id === "string" && obj.id ? obj.id : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    out.push({ id, type: "function", function: { name: f.name, arguments: args } });
  }
  return out;
}

/** Contrato que se agrega al prompt cuando el request trae tools. */
export function renderToolContract(tools: readonly ChatTool[]): string {
  const schemas = JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters ?? { type: "object", properties: {} },
  })));
  return [
    "[PROTOCOLO DE FUNCIONES EXTERNAS — IMPORTANTE]",
    "Este chat no tiene herramientas nativas, pero esta conectado a un CLIENTE EXTERNO (la TUI) que si puede ejecutar funciones en la computadora del usuario.",
    "El cliente parsea tu respuesta: cuando necesites una funcion, responde UNICAMENTE con este JSON, sin texto adicional y sin cercas de codigo:",
    '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"<nombre>","arguments":{"<clave>":"<valor>"}}}]}',
    "IMPORTANTE: `arguments` es un OBJETO JSON anidado directo, NO un string con comillas escapadas. Si no lleva parametros, usa {} .",
    "El cliente la ejecutara y en el SIGUIENTE mensaje te devolvera el resultado con el formato:",
    "tool (call_1): <resultado>",
    "Nunca digas que no tienes acceso; el cliente externo ejecuta la funcion por ti. Puedes pedir varias a la vez.",
    "Cuando ya no necesites ninguna funcion, da la respuesta final en texto plano (sin sobre JSON).",
    "",
    "Funciones disponibles (JSON):",
    schemas,
  ].join("\n");
}

/** El modelo a veces emite `"arguments":"{"a":1}"` (comillas internas sin
 *  escapar), que es JSON invalido. Se re-escapa el valor interno. */
function repairUnescapedArguments(text: string): string {
  // Una sola pasada global: el replace escanea el texto ORIGINAL, asi no se
  // re-matchea su propia salida (aquel loop doble-escapaba 6 veces).
  return text.replace(
    /"arguments"\s*:\s*"(\{[^{}]*\})"/g,
    (_match, inner: string) => `"arguments":${JSON.stringify(inner)}`,
  );
}

/** Parsea el sobre tool_calls de la respuesta del modelo (directo o en cerca). */
export function parseToolCalls(text: string, allowed: ReadonlySet<string>): ChatToolCall[] {
  const candidates: string[] = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch {
      try { parsed = JSON.parse(repairUnescapedArguments(candidate)); } catch { continue; }
    }
    if (!parsed || typeof parsed !== "object") continue;
    const calls = (parsed as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) continue;
    const out: ChatToolCall[] = [];
    let ok = true;
    for (const item of calls) {
      if (!item || typeof item !== "object") { ok = false; break; }
      const obj = item as Record<string, unknown>;
      const fn = obj.function;
      if (!fn || typeof fn !== "object") { ok = false; break; }
      const f = fn as Record<string, unknown>;
      const name = typeof f.name === "string" ? f.name : "";
      if (!name || (allowed.size > 0 && !allowed.has(name))) { ok = false; break; }
      const args = typeof f.arguments === "string" ? f.arguments
        : f.arguments !== undefined ? JSON.stringify(f.arguments) : "{}";
      const id = typeof obj.id === "string" && obj.id ? obj.id : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      out.push({ id, type: "function", function: { name, arguments: args } });
    }
    if (ok && out.length) return out;
  }
  return [];
}
