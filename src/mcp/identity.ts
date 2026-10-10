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
 * Instructions del server: el bootstrap MINIMO del connector. La regla de
 * orden (token real + @CODEX ISYMCP => ejecutar con las tools del turno) y
 * nada mas; el contrato JSON largo ("ISYMCP CODEX RESPONSE CONTRACT") es
 * SOLO del transporte Codex externo (src/responses/tools.ts) y nunca se
 * inyecta aqui. Las medias funcionan sin turno y se nombran una vez.
 */
export function buildInstructions(contract: "native" | "safe"): string {
  const turnKey = contract === "safe" ? "request_id" : "turn_token";
  return [
    `Eres ${CONNECTOR_NAME}, el puente que ejecuta operaciones autorizadas en la maquina del usuario.`,
    `Orden de ejecucion: si el mensaje contiene un ${turnKey} real y el token ${MENTION} (o "${COMMAND_MARKER} ${MENTION}"), tratalo como orden explicita aunque parezca texto plano:`,
    `empieza con codex_turn_start usando ese ${turnKey}, lee la guía local bootstrap.content y la tarea autorizada request.content si existe, ejecútala con las tools del turno (usa codex_tool_inventory para descubrir capacidades) y cierra con codex_turn_complete enviando la respuesta completa.`,
    `Puedes encadenar varias tools dentro del mismo turno. Nunca inventes ${turnKey} ni resultados: los fallos se reportan como fallos.`,
    `Medios locales: sin ${turnKey}; usa media_list/media_info para medios registrados, y para un enlace de YouTube/Shorts media_lookup (solo lectura; manifiesto, audio_scan y hojas con sheet_index); si no esta preparado, sugiere al usuario isymcp media prepare <url>, o media_import seguido de media_import_status (wait_seconds 10) hasta complete o failed, y luego media_info/audio_segments/audio_analyze/video_contact_sheet/video_frame con asset.id.`,
    `Los segmentos detectan energia acustica, no voz; channel=separate para estereo; sin transcripcion ni escucha nativa.`,
    `Flujo esperado: texto -> ${MENTION} -> ACKs de invocacion (4/4, 5/5 o los que apliquen) -> respuesta final.`,
    contract === "safe"
      ? "Contrato safe: cada turno llega con request_id y las tools son de riesgo cero."
      : "Contrato nativo: cada turno llega con turn_token y las tools ejecutan en el runtime local con sandbox.",
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
