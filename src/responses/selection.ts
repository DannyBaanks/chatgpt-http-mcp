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

/** Some Web composer builds prefix the displayed effort with its model version
 * (for example, “5.6 High”). Accept that form only when it matches the exact
 * selected model; the 3/3 slider position remains mandatory. */
export function isHighEffortLabel(modelLabel: string, effort: string | null): boolean {
  const normalized = effort?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
  if (HIGH_LABELS.has(normalized)) return true;
  const prefixed = /^(\d+(?:\.\d+)?)\s+(high|alta|alto)$/i.exec(normalized);
  const selectedVersion = /^gpt-(\d+(?:\.\d+)?)(?:\s|$)/i.exec(modelLabel)?.[1];
  return Boolean(prefixed && selectedVersion && prefixed[1] === selectedVersion && HIGH_LABELS.has(prefixed[2]!.toLowerCase()));
}

/** Public Web aliases identify exact visible labels, not native API models. */
export function webModelLabel(model: string): string {
  if (model === "chatgpt-web/gpt-5.6-sol") return "GPT-5.6 Sol";
  if (model === "chatgpt-web/gpt-6") return "GPT-6";
  throw new WebTaskError("web_model_selection_unsupported", 400, "unsupported Web model alias");
}

export function assertWebSelection(model: string, effort: unknown, ...observation: [ComposerSettings?]): void {
  const label = webModelLabel(model);
  if (effort !== "high")
    throw new WebTaskError("web_model_selection_unsupported", 400, "this Responses delivery verifies only high / 3 of 3");
  const seen = observation[0];
  if (observation.length && (!seen || seen.model !== label || !isHighEffortLabel(label, seen.effort) || seen.effortPosition !== 3 || seen.effortSteps !== 3))
    throw new WebTaskError("web_model_state_mismatch", 409, `requested ${label} / High; observed ${seen?.model ?? "unknown"} / ${seen?.effort ?? "unknown"} (${seen?.effortPosition ?? "?"}/${seen?.effortSteps ?? "?"})`);
}
