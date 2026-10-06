// error-taxonomy.ts — M6 (P0): clasificacion de fallos del bridge Web.
// El tipo viaja como prefijo del Error ("<type>: detalle") y se mapea a un
// status HTTP estable para que el caller distinga donde fallo:
//   modelo invalido / sesion / connector / submit / captura / browser / interno.
export const ERROR_STATUS: Record<string, number> = {
  chat_invalid_json: 400,
  not_web_model: 400,
  web_empty_prompt: 400,
  web_session_missing: 401,
  web_session_expired: 401,
  web_connector_unavailable: 409,
  web_turn_submit_failed: 502,
  web_capture_empty: 504,
  web_no_response: 504,
  web_browser_missing: 503,
  web_context_answer_loop: 502,
  web_turn_failed: 500,
};

export function classifyWebError(message: string): { type: string; status: number } {
  const named = /^([a-z][a-z0-9_]*):/.exec(message.trim())?.[1] ?? "";
  if (named && ERROR_STATUS[named] !== undefined) return { type: named, status: ERROR_STATUS[named]! };
  return { type: "web_turn_failed", status: 500 };
}
