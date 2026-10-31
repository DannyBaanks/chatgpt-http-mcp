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
import { securePrivatePath } from "./platform/private-path";

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
    if (assignment === undefined) continue;
    const equals = assignment.indexOf("=");
    if (equals < 0 || assignment.slice(0, equals).trim() !== key) continue;
    const raw = assignment.slice(equals + 1).trim();
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
  if (model) return model.startsWith("chatgpt-web/");
  // A profile owns its model/provider configuration; only an explicit Web
  // model above may opt it into the bridge. Never infer its contents here.
  return !options.some(arg => arg === "--profile" || arg.startsWith("--profile=") || arg.startsWith("-p"));
}

export function buildCodexArgs(userArgs: string[], port = DEFAULT_PORT, catalogPath?: string): string[] {
  if (!usesWebBridge(userArgs)) return [...userArgs];
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("puerto del bridge invalido");
  const url = `http://127.0.0.1:${port}/v1`;
  return [...buildIsolatedCodexArgs(url, requestedCodexModel(userArgs), configString(userArgs, "model_reasoning_effort"), catalogPath), ...userArgs];
}

/**
 * Crea el acceso directo de Windows via WScript.Shell. El COM de WScript.Shell
 * puede colgar de forma transitoria en un runner/sesion frios, asi que se
 * reintenta con un timeout creciente en vez de fallar al primer cuelgue.
 */
export function createWindowsShortcut(powershell: string, ps: string): void {
  const timeouts = [20000, 30000, 45000];
  let lastError = "";
  for (let attempt = 0; attempt < timeouts.length; attempt++) {
    const result = Bun.spawnSync([powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], { stdout: "ignore", stderr: "pipe",
      timeout: timeouts[attempt] });
    if (result.exitCode === 0) return;
    lastError = result.stderr.toString().slice(0, 250);
    if (attempt < timeouts.length - 1) Bun.sleepSync(500);
  }
  throw new Error(`no se pudo crear el acceso directo de Windows tras ${timeouts.length} intentos: ${lastError}`);
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

  if (process.platform === "win32") {
    const winBinDir = options.binDir ?? join(process.env.LOCALAPPDATA ?? home, "Programs", "ISyMCP");
    const winAppDir = options.appDir ?? join(process.env.APPDATA ?? home, "Microsoft", "Windows", "Start Menu", "Programs", "ISyMCP");
    mkdirSync(winBinDir, { recursive: true });
    mkdirSync(winAppDir, { recursive: true });
    securePrivatePath(winBinDir, true);
    securePrivatePath(winAppDir, true);
    const binPath = join(winBinDir, "codex-isymcp.cmd");
    const desktopPath = join(winAppDir, "Codex (ISyMCP Web).lnk");
    const entryPoint = join(import.meta.dir, "isymcp.ts");
    writeFileSync(binPath, `@echo off\r\nsetlocal\r\nif not defined CODEX_WEB_HTTP_PORT set "CODEX_WEB_HTTP_PORT=${port}"\r\n"${process.execPath}" run "${
      entryPoint}" codex %*\r\n`);
    securePrivatePath(binPath, false);
    const b64 = (value: string) => Buffer.from(value, "utf16le").toString("base64");
    const ps =
      (`$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; $shortcut=$shell.CreateShortcut([Text.Encoding]::Unicode.GetString([Conver` +
        `t]::FromBase64String('${
      b64(
      desktopPath)}'))); $shortcut.TargetPath=[Environment]::GetEnvironmentVariable('ComSpec'); $bin=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64` +
        `String('${
      b64(
      binPath)}')); $shortcut.Arguments='/d /s /c ""'+$bin+'""'; $shortcut.WorkingDirectory=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${
      b64(join(import.meta.dir, ".."))}')); $shortcut.Description='Codex con el perfil Web aislado de ISyMCP'; $shortcut.Save()`);
    const powershell = process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
    createWindowsShortcut(powershell, ps);
    securePrivatePath(desktopPath, false);
    return { binPath, desktopPath };
  }

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
  const binDir = options.binDir ?? (process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? home, "Programs", "ISyMCP") : join(home, ".local", "bin"));
  const appDir = options.appDir ?? (process.platform === "win32" ? join(process.env.APPDATA ?? home, "Microsoft", "Windows", "Start Menu", "Programs",
    "ISyMCP") : join(home, ".local", "share", "applications"));

  const binPath = join(binDir, process.platform === "win32" ? "codex-isymcp.cmd" : "codex-isymcp");
  const desktopPath = join(appDir, process.platform === "win32" ? "Codex (ISyMCP Web).lnk" : "codex-isymcp.desktop");

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
