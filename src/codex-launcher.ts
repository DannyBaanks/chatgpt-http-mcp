// src/codex-launcher.ts — lanzador de Codex desacoplado con perfiles aislados.
//
// Solo los modelos Web usan el proveedor isymcp_web de este proceso.
// El proveedor integrado de OpenAI y la configuración global permanecen aparte.
//
// 1. Verifica si el bridge local está encendido; si no, puede levantarlo.
// 2. Lanza el binario `codex` pasando la configuración dinámicamente sin tocar el disco.
// 3. Genera lanzadores de escritorio (.desktop) y wrappers en ~/.local/bin/codex-isymcp.
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bridgeAuthHeaders } from "./local-guard";
import { buildIsolatedCodexArgs } from "../scripts/install-web-models";

const DEFAULT_PORT = process.env.CODEX_WEB_HTTP_PORT?.trim() || "8791";

export async function isBridgeAlive(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: bridgeAuthHeaders(),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const health = await res.json();
    return health.status === "ok" && health.web_models === "on" && typeof health.upstream === "string";
  } catch {
    return false;
  }
}

function configString(args: string[], key: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    const assignment = arg === "-c" || arg === "--config" ? args[++i]
      : arg.startsWith("--config=") ? arg.slice(9)
      : arg.startsWith("-c") ? arg.slice(2).replace(/^=/, "") : undefined;
    if (!assignment?.startsWith(`${key}=`)) continue;
    const raw = assignment.slice(key.length + 1).trim();
    try { const parsed = JSON.parse(raw); if (typeof parsed === "string") value = parsed; }
    catch { value = raw.replace(/^'|'$/g, ""); }
  }
  return value;
}

export function requestedCodexModel(args: string[]): string | undefined {
  let model = configString(args, "model");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "-m" || arg === "--model") model = args[++i];
    else if (arg.startsWith("--model=")) model = arg.slice(8);
    else if (arg.startsWith("-m")) model = arg.slice(2).replace(/^=/, "");
  }
  return model;
}

export function usesWebBridge(args: string[]): boolean {
  const options = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
  if (options.some(arg => ["--help", "-h", "--version", "-V"].includes(arg))) return false;
  const model = requestedCodexModel(args);
  return !model || model.startsWith("chatgpt-web/");
}

export function buildCodexArgs(userArgs: string[], port = DEFAULT_PORT, catalogPath?: string): string[] {
  if (!usesWebBridge(userArgs)) return [...userArgs];
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("puerto del bridge invalido");
  const url = `http://127.0.0.1:${port}/v1`;
  return [...buildIsolatedCodexArgs(url, requestedCodexModel(userArgs), configString(userArgs, "model_reasoning_effort"), catalogPath), ...userArgs];
}

export function installDesktopLauncher(options: { binDir?: string; appDir?: string; port?: string } = {}): {
  binPath: string;
  desktopPath: string;
} {
  const home = homedir();
  const binDir = options.binDir ?? join(home, ".local", "bin");
  const appDir = options.appDir ?? join(home, ".local", "share", "applications");
  const port = options.port ?? DEFAULT_PORT;
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("puerto del bridge invalido");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });

  const binPath = join(binDir, "codex-isymcp");
  const desktopPath = join(appDir, "codex-isymcp.desktop");

  const binScript = `#!/usr/bin/env bash
# codex-isymcp — lanzador aislado de Codex con modelos web ISyMCP
# No muta ~/.codex/config.toml
set -e
export CODEX_WEB_HTTP_PORT="\${CODEX_WEB_HTTP_PORT:-${port}}"
exec isymcp codex "$@"
`;

  writeFileSync(binPath, binScript, { mode: 0o755 });
  chmodSync(binPath, 0o755);

  const desktopContent = `[Desktop Entry]
Type=Application
Version=1.0
Name=Codex (ISyMCP Web)
GenericName=AI Coding Assistant with Web Models
Comment=Codex con modelos ChatGPT Web (Bridge local aislado)
Exec="${binPath.replace(/([\\"`$])/g, "\\$1")}"
Icon=${join(import.meta.dir, "..", "assets", "isymcp-icon.png")}
Terminal=true
Categories=Development;Utility;
StartupNotify=true
`;

  writeFileSync(desktopPath, desktopContent, { mode: 0o644 });

  return { binPath, desktopPath };
}

export function removeDesktopLauncher(options: { binDir?: string; appDir?: string } = {}): {
  removedBin: boolean;
  removedDesktop: boolean;
} {
  const home = homedir();
  const binDir = options.binDir ?? join(home, ".local", "bin");
  const appDir = options.appDir ?? join(home, ".local", "share", "applications");

  const binPath = join(binDir, "codex-isymcp");
  const desktopPath = join(appDir, "codex-isymcp.desktop");

  let removedBin = false;
  let removedDesktop = false;

  if (existsSync(binPath)) {
    unlinkSync(binPath);
    removedBin = true;
  }
  if (existsSync(desktopPath)) {
    unlinkSync(desktopPath);
    removedDesktop = true;
  }

  return { removedBin, removedDesktop };
}
