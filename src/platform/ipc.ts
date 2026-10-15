import { createHash } from "node:crypto";
import { win32 } from "node:path";

export function isWindowsPipePath(path: string): boolean {
  return /^\\\\\.\\pipe\\[A-Za-z0-9_.-]+$/i.test(path);
}

/**
 * Keep the existing per-session endpoint name while mapping it to a private,
 * short Windows named pipe. The pipe's default DACL comes from this process's
 * Windows token; the random session directory is represented by a stable hash.
 */
export function localIpcPath(path: string): string {
  if (process.platform !== "win32" || isWindowsPipePath(path)) return path;
  if (!win32.isAbsolute(path)) throw Error("local_ipc_path_must_be_absolute");
  const scope = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}\\${win32.resolve(win32.dirname(path)).toLowerCase()}`;
  const identity = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  const label = win32.basename(path).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 32) || "endpoint";
  return `\\\\.\\pipe\\isymcp-${identity}-${label}`;
}
