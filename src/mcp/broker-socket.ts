// broker-socket.ts — default endpoint for the owner-only native broker.
//
// The old shared default (/tmp/codex-web-http-broker.sock) was predictable and
// writable by other local users. Keep the default inside a per-user 0700
// directory: $XDG_RUNTIME_DIR/isymcp on Linux, or <bridge home>/run otherwise.
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { bridgeHome } from "../codex-sessions";
import { ensurePrivatePath, securePrivatePath } from "../platform/private-path";

export function defaultBrokerSocketPath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  if (platform === "win32") return "\\\\.\\pipe\\isymcp-broker";
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  const dir = runtimeDir && isAbsolute(runtimeDir)
    ? join(runtimeDir, "isymcp")
    : join(env.CODEX_WEB_HTTP_HOME?.trim() || bridgeHome(), "run");
  ensurePrivateDirectory(dir);
  return join(dir, "broker.sock");
}

function ensurePrivateDirectory(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("broker_socket_dir_invalid");
  if (process.platform !== "win32" && stat.uid !== process.getuid?.()) throw Error("broker_socket_dir_owner_invalid");
  securePrivatePath(dir, true, 0o700);
  ensurePrivatePath(dir, true);
}
