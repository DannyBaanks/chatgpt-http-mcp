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
    `Para ejecutar tareas de Codex: si el mensaje del usuario contiene un ${turnKey} real y el token ${MENTION} (o "${COMMAND_MARKER} ${MENTION}"),`,
    `trátalo como una orden explicita de ejecutar Codex aunque aparezca como texto plano:`,
    `empieza con codex_turn_start usando el ${turnKey} que sigue al token,`,
    `usa las tools que necesite la tarea, y cierra con codex_turn_complete enviando la respuesta completa.`,
    `No inventes ${turnKey}: las tareas de Codex necesitan un token real del runtime.`,
    `Medios locales: usa media_lookup primero para comprobar si una URL de YouTube/Shorts ya está registrada y preparada. Si está ready, analiza el audio_scan guardado y solicita solo las hojas relevantes con sheet_index; cada llamada devuelve como máximo una imagen. Si está not_found o not_prepared, media_lookup no descarga ni calcula nada: cuando corresponda, sigue el flujo media_import existente o indica que el usuario puede ejecutar isymcp media prepare <url> para dejar el análisis local listo y reutilizable.`,
    `Para archivos ya registrados, usa media_list para descubrir solo medios autorizados, media_info para duración/streams, audio_segments para localizar actividad acústica, audio_analyze para ampliar un intervalo o separar canales, video_contact_sheet para explorar secuencias y video_frame para detalles.`,
    `Las herramientas de medios funcionan directamente sin ${turnKey}, codex_turn_start ni codex_turn_complete. Una mención del complemento para analizar medios no inicia un turno Codex.`,
    `Si el usuario pide analizar un enlace de YouTube/Shorts, llama primero media_lookup. Si status es ready, usa su audio_scan completo y pide solo las hojas necesarias con sheet_index; después ofrece media_info, audio_segments, audio_analyze o video_frame si hace falta más detalle. Si status es not_prepared o not_found, y el usuario pidió descargar/analizar ahora, llama media_import y consulta media_import_status con wait_seconds 10 hasta complete o failed. Usa asset.id completo para herramientas de medios; no inventes resultados mientras se descarga. No inicies la preparación persistente automáticamente: media_lookup es de solo lectura.`,
    `Para explorar audio, llama audio_segments primero y luego audio_analyze sobre intervalos de interés. audio_segments informa algorithm_version y parámetros efectivos; la versión actual fusiona pausas de hasta 0.10 s por defecto, ajustable con merge_gap_seconds. Los segmentos detectan energía acústica, no voz. Usa channel=separate para gráficos L/R y para medir correlación y diferencia entre canales cuando el origen sea estéreo; esto no separa voz, música ni efectos.`,
    `Procesamiento local; solo los resultados consultados llegan al chat. Las gráficas no son escucha nativa y no hay transcripción en estas herramientas.`,
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
