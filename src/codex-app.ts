export const CODEX_APP_PROFILE_UNSUPPORTED =
  "web_app_profile_unsupported: isolated Desktop App profiles copy private authentication and remain UNKNOWN / NO EXECUTE; use --client cli";

/** Kept as an explicit fail-closed API for old callers and saved launch receipts. */
export function prepareCodexApp(_intent: unknown, _options: unknown): never {
  throw new Error(CODEX_APP_PROFILE_UNSUPPORTED);
}

export async function launchCodexApp(_plan: unknown): Promise<never> {
  throw new Error(CODEX_APP_PROFILE_UNSUPPORTED);
}
