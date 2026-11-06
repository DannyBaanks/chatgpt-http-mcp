/** Deliberately narrow proof grant. It permits no caller-provided program,
 * marker syntax, filesystem operation or background process. The actual host
 * policy is disclosed separately; this is not a read-only OS sandbox. */
import { linkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensurePrivatePath } from "../platform/private-path";

export interface CurrentOwnerCanary { marker: string; hostSandbox: "dangerFullAccess" }

/** Publish a complete 0600 receipt atomically, without replacing an earlier
 * result. The controller can never observe apply_patch's default 0644 file. */
export function publishCanaryResult(directory: string, result: unknown): void {
  ensurePrivatePath(directory, true);
  const temporary = join(directory, ".native-result-" + randomUUID());
  writeFileSync(temporary, JSON.stringify(result) + "\n", { flag: "wx", mode: 0o600 });
  try { linkSync(temporary, join(directory, "native-result.json")); }
  finally { unlinkSync(temporary); }
}

export function canaryCommand(marker: string): string[] {
  if (!/^ISYMCP_NATIVE_[a-f0-9]{32}$/.test(marker)) throw Error("invalid_native_canary_marker");
  return ["sh", "-c", `echo ${marker}; echo ISYMCP_NATIVE_CALL_ID:$CODEX_TOOL_CALL_ID`];
}

export function validCanaryEnvironment(environment: any): boolean {
  if (environment?.sandboxPolicy?.type !== "dangerFullAccess" ||
      environment.executionGrant?.kind !== "current-turn-canary") return false;
  try { canaryCommand(environment.executionGrant.marker); return true; }
  catch { return false; }
}
