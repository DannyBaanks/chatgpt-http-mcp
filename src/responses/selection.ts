import type { ComposerSettings } from "../chatgpt-settings";

export class WebTaskError extends Error {
  constructor(readonly type: string, readonly status: number, detail: string) {
    super(`${type}: ${detail}`);
    this.name = "WebTaskError";
  }
}

export function assertWebSelection(model: string, effort: unknown, ...observation: [ComposerSettings?]): void {
  if (model !== "chatgpt-web/gpt-5.6-sol" || effort !== "high")
    throw new WebTaskError("web_model_selection_unsupported", 400, "this Responses delivery verifies only GPT-5.6 Sol / high");
  const seen = observation[0];
  if (observation.length && (!seen || seen.model !== "GPT-5.6 Sol" || seen.effort?.toLowerCase() !== "high" || seen.effortPosition !== 3 || seen.effortSteps !== 3))
    throw new WebTaskError("web_model_state_mismatch", 409, `requested GPT-5.6 Sol / High; observed ${seen?.model ?? "unknown"} / ${seen?.effort ?? "unknown"} (${seen?.effortPosition ?? "?"}/${seen?.effortSteps ?? "?"})`);
}
