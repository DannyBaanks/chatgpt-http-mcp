// identity.ts — identidad pública del connector en chatgpt.com.
//
// Un solo lugar define el NOMBRE exacto que se ve en la pagina, el token
// @ que el usuario escribe en el composer, y el bloque de texto que convierte
// ese token en una orden real. Si el nombre cambia en la pagina y aqui no,
// el MCP miente: por eso las dos cosas salen de estas constantes.

/** Nombre EXACTO del connector tal como se crea en chatgpt.com. */
export const CONNECTOR_NAME = "Codex ISyMCP";

/** Token que el usuario escribe en el texto para ordenar la ejecucion. */
export const MENTION = "@CODEX ISYMCP";

/**
 * Prefijo que reconoce el modelo como "esto es el app, no texto". En ChatGPT
 * el app se elige en el composer: no existe un @ de texto que rutee solo. Lo
 * que SI funciona es que las instructions del MCP le digan al modelo que
 * trate este bloque como comando, aunque en pantalla parezca texto plano.
 */
export const COMMAND_MARKER = "COMANDO:";

/** Las 8 tools que el Codex GPT MCP expone (contrato nativo). */
export const CODEX_TOOLS = [
  "codex_turn_start",
  "codex_exec",
  "codex_write_stdin",
  "codex_apply_patch",
  "codex_view_image",
  "codex_tool_inventory",
  "codex_tool_call",
  "codex_turn_complete",
] as const;

/**
 * Instructions del server. Van dos cosas: el nombre del app (para que el
 * modelo lo asocie) y la regla del token @ (para que texto plano dispare las
 * tools). El flujo de ACK se respeta: primero el texto, despues la
 * confirmacion del turno.
 */
export function buildInstructions(contract: "native" | "safe"): string {
  const turnKey = contract === "safe" ? "request_id" : "turn_token";
  return [
    `Eres ${CONNECTOR_NAME}, el puente que ejecuta Codex sobre la maquina del usuario.`,
    `Si el mensaje del usuario contiene el token ${MENTION} (o "${COMMAND_MARKER} ${MENTION}"),`,
    `tratalo como una orden explicita de ejecutar Codex aunque aparezca como texto plano:`,
    `empieza con codex_turn_start usando el ${turnKey} que sigue al token,`,
    `usa las tools que necesite la tarea, y cerrá con codex_turn_complete enviando la respuesta completa.`,
    `No respondas de memoria: si el mensaje trae ${MENTION}, tenes que llamar a las tools.`,
    `Flujo esperado: texto -> ${MENTION} -> ACKs de invocacion (4/4, 5/5 o los que apliquen) -> respuesta final.`,
    contract === "safe"
      ? "Contrato safe: cada turno llega con request_id y las tools son de riesgo cero."
      : "Contrato nativo: cada turno llega con turn_token y las tools ejecutan en el harness Codex.",
  ].join(" ");
}

/**
 * Texto listo para pegar en el composer de chatgpt.com con el app elegido.
 * El texto va primero; el comando @ al final, que es donde el modelo lo ve
 * como orden y no como parte de la pregunta.
 */
export function buildChatGPTCommand(text: string, options: { turnToken?: string; effort?: string } = {}): string {
  const lines = [text.trim(), ""];
  lines.push(`${COMMAND_MARKER} ${MENTION}`);
  if (options.turnToken) lines.push(`${turnKeyLabel(options.turnToken)}: ${options.turnToken}`);
  if (options.effort) lines.push(`effort: ${options.effort}`);
  lines.push(`Ejecuta la tarea de arriba con las tools de ${CONNECTOR_NAME} y responde con el resultado.`);
  return lines.join("\n");
}

function turnKeyLabel(turnToken: string): string {
  return turnToken.startsWith("req_") ? "request_id" : "turn_token";
}