import type { ComposerSettings } from "../chatgpt-settings";

export class WebTaskError extends Error {
  constructor(readonly type: string, readonly status: number, detail: string) {
    super(`${type}: ${detail}`);
    this.name = "WebTaskError";
  }
}

/**
 * Etiquetas visibles del nivel "high". ChatGPT las localiza de forma
 * inconsistente: en un chat nuevo muestra "High" y dentro de una conversacion
 * existente "Alta" (cuenta es-ES, visto 2026-10-07 en el E2E A/B/A/B). La
 * posicion exacta 3/3 sigue siendo obligatoria: la etiqueta solo confirma.
 */
const HIGH_LABELS = new Set(["high", "alta", "alto"]);

export function assertWebSelection(model: string, effort: unknown, ...observation: [ComposerSettings?]): void {
  if (model !== "chatgpt-web/gpt-5.6-sol" || effort !== "high")
    throw new WebTaskError("web_model_selection_unsupported", 400, "this Responses delivery verifies only GPT-5.6 Sol / high");
  const seen = observation[0];
  if (observation.length && (!seen || seen.model !== "GPT-5.6 Sol" || !HIGH_LABELS.has(seen.effort?.trim().toLowerCase() ?? "") || seen.effortPosition !== 3 || seen.effortSteps !== 3))
    throw new WebTaskError("web_model_state_mismatch", 409, `requested GPT-5.6 Sol / High; observed ${seen?.model ?? "unknown"} / ${seen?.effort ?? "unknown"} (${seen?.effortPosition ?? "?"}/${seen?.effortSteps ?? "?"})`);
}
