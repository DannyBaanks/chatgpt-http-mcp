// src/codex-launcher.ts — lanzador de Codex desacoplado con perfiles aislados.
//
// En lugar de mutar globalmente ~/.codex/config.toml, ejecuta Codex pasando
// `-c openai_base_url=http://127.0.0.1:8791/v1` de forma efímera e independiente.
//
// 1. Verifica si el bridge local está encendido; si no, puede levantarlo.
// 2. Lanza el binario `codex` pasando la configuración dinámicamente sin tocar el disco.
// 3. Genera lanzadores de escritorio (.desktop) y wrappers en ~/.local/bin/codex-isymcp.
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bridgeAuthHeaders } from "./local-guard";

const DEFAULT_PORT = process.env.CODEX_WEB_HTTP_PORT?.trim() || "8791";

export async function isBridgeAlive(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: bridgeAuthHeaders(),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok || res.status === 401; // 401 significa que el bridge está vivo exigiendo token
  } catch {
    return false;
  }
}

export function buildCodexArgs(userArgs: string[], port = DEFAULT_PORT): string[] {
  const url = `http://127.0.0.1:${port}/v1`;
  return ["-c", `openai_base_url="${url}"`, ...userArgs];
}

export function installDesktopLauncher(options: { binDir?: string; appDir?: string; port?: string } = {}): {
  binPath: string;
  desktopPath: string;
} {
  const home = homedir();
  const binDir = options.binDir ?? join(home, ".local", "bin");
  const appDir = options.appDir ?? join(home, ".local", "share", "applications");
  const port = options.port ?? DEFAULT_PORT;

  mkdirSync(binDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });

  const binPath = join(binDir, "codex-isymcp");
  const desktopPath = join(appDir, "codex-isymcp.desktop");

  const binScript = `#!/usr/bin/env bash
# codex-isymcp — lanzador aislado de Codex con modelos web ISyMCP
# No muta ~/.codex/config.toml
set -e

PORT="\${CODEX_WEB_HTTP_PORT:-${port}}"
BRIDGE_URL="http://127.0.0.1:\$PORT"

# Comprobar si el bridge responde; si no, sugerir o levantar
if ! curl -s --max-time 1 "\$BRIDGE_URL/health" >/dev/null 2>&1; then
  echo "[codex-isymcp] Bridge local apagado en \$BRIDGE_URL."
  echo "[codex-isymcp] Iniciando bridge temporal..."
  # Si el binario isymcp está disponible o el proyecto existe
  if command -v isymcp >/dev/null 2>&1; then
    isymcp server start
  fi
fi

exec codex -c openai_base_url="\$BRIDGE_URL/v1" "$@"
`;

  writeFileSync(binPath, binScript, { mode: 0o755 });
  chmodSync(binPath, 0o755);

  const desktopContent = `[Desktop Entry]
Type=Application
Version=1.0
Name=Codex (ISyMCP Web)
GenericName=AI Coding Assistant with Web Models
Comment=Codex con modelos ChatGPT Web (Bridge local aislado)
Exec=${binPath} %U
Icon=chatgpt
Terminal=false
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
