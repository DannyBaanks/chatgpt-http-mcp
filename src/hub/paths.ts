// src/hub/paths.ts — Rutas del hub, sin dependencias pesadas: las usa también el conector
// (`isymcp hub connect`), que debe arrancar al instante en cada TUI.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

type Env = Record<string, string | undefined>;

export function hubHome(env: Env = process.env): string {
  return join(env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http"), "hub");
}

export function hubConfigPath(env: Env = process.env): string {
  return env.ISYMCP_HUB_CONFIG?.trim() || join(hubHome(env), "servers.json");
}

export function hubSocketPath(env: Env = process.env): string {
  if (env.ISYMCP_HUB_SOCKET?.trim()) return env.ISYMCP_HUB_SOCKET.trim();
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  const dir = runtimeDir && isAbsolute(runtimeDir) ? join(runtimeDir, "isymcp") : join(hubHome(env), "run");
  return join(dir, "hub.sock");
}

/** Binario Zig del hub (daemon + conector), construido con `zig build` en hub/. */
export function hubBinaryPath(root: string, env: Env = process.env): string {
  return env.ISYMCP_HUB_BIN?.trim() || join(root, "hub", "zig-out", "bin", "isymcp-hub");
}
