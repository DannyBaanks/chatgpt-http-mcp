// src/tui-launcher.ts — Spawner de consolas TUI de Antigravity (agy) en terminales de escritorio o tmux.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export interface SpawnAgyOptions {
  prompt: string;
  cwd?: string;
  title?: string;
  mode?: "auto" | "plan" | "accept-edits";
  dangerouslySkipPermissions?: boolean;
  terminalPreference?: "auto" | "gui" | "tmux";
  includeMonitorHint?: boolean;
  dryRun?: boolean;
}

export interface SpawnAgyResult {
  ok: boolean;
  pid?: number;
  terminal: string;
  cwd: string;
  command: string[];
  message: string;
  error?: string;
}

export function detectTerminalEmulator(): string | null {
  const candidates = [
    "/usr/bin/gnome-terminal",
    "/usr/bin/x-terminal-emulator",
    "/usr/bin/kitty",
    "/usr/bin/alacritty",
    "/usr/bin/konsole",
    "/usr/bin/xterm",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function findAgyBinary(): string {
  const candidates = [
    joinPath(homedir(), ".local", "bin", "agy"),
    "/usr/local/bin/agy",
    "/usr/bin/agy",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "agy";
}

function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

export async function spawnAgyTui(options: SpawnAgyOptions): Promise<SpawnAgyResult> {
  const agyBin = findAgyBinary();
  const cwd = options.cwd || process.cwd();
  const mode = options.mode || "auto";
  const title = options.title || "Antigravity (AGY) Agent — [ISyMCP Dispatch]";
  const skipPerms = options.dangerouslySkipPermissions ?? true;
  const pref = options.terminalPreference || "auto";

  let finalPrompt = options.prompt.trim();
  if (options.includeMonitorHint ?? true) {
    finalPrompt += "\n\n[COORDINACIÓN ISyMCP]: Tarea lanzada remotamente por ChatGPT. El monitor local de ISyMCP está activo en http://127.0.0.1:8799. Mantén sincronizado tu reporte de avance.";
  }

  const agyArgs: string[] = [
    "-i", finalPrompt,
    "--mode", mode,
  ];
  if (skipPerms) {
    agyArgs.push("--dangerously-skip-permissions");
  }

  const isX11OrWayland = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const guiTerm = detectTerminalEmulator();

  if (options.dryRun) {
    const targetTerm = (isX11OrWayland && guiTerm) ? guiTerm : (existsSync("/usr/bin/tmux") ? "tmux" : "none");
    const previewCmd = targetTerm === "tmux"
      ? ["tmux", "new-session", "-d", "-s", "agy_dryrun", "-c", cwd, `${agyBin} ${agyArgs.join(" ")}`]
      : [guiTerm || "terminal", "--title", title, "--", agyBin, ...agyArgs];
    return {
      ok: true,
      pid: 0,
      terminal: targetTerm,
      cwd,
      command: previewCmd,
      message: "Dry-run: comando preparado exitosamente sin spawn real.",
    };
  }

  // 1. Terminal GUI si hay pantalla disponible
  if ((pref === "auto" || pref === "gui") && isX11OrWayland && guiTerm) {
    let termCmd: string[] = [];
    if (guiTerm.includes("gnome-terminal")) {
      termCmd = [
        guiTerm,
        `--title=${title}`,
        `--working-directory=${cwd}`,
        "--",
        agyBin,
        ...agyArgs,
      ];
    } else {
      // x-terminal-emulator o xterm
      termCmd = [
        guiTerm,
        "-T", title,
        "-e",
        `${agyBin} ${agyArgs.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`,
      ];
    }

    try {
      const child = spawn(termCmd[0], termCmd.slice(1), {
        cwd,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || ":0",
        },
      });
      child.unref();

      return {
        ok: true,
        pid: child.pid,
        terminal: guiTerm,
        cwd,
        command: termCmd,
        message: `Consola TUI de Antigravity (agy) lanzada exitosamente en ventana visible (${guiTerm}) con PID ${child.pid}.`,
      };
    } catch (err) {
      return {
        ok: false,
        terminal: guiTerm,
        cwd,
        command: termCmd,
        message: "Fallo al abrir terminal GUI",
        error: (err as Error).message,
      };
    }
  }

  // 2. Fallback a tmux si no hay GUI o se prefiere tmux
  const hasTmux = existsSync("/usr/bin/tmux");
  if (hasTmux) {
    const sessionName = `agy_${Date.now().toString(36)}`;
    const tmuxCmd = [
      "tmux",
      "new-session",
      "-d",
      "-s", sessionName,
      "-c", cwd,
      `${agyBin} ${agyArgs.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`,
    ];

    try {
      const child = spawn(tmuxCmd[0], tmuxCmd.slice(1), {
        cwd,
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      return {
        ok: true,
        pid: child.pid,
        terminal: "tmux",
        cwd,
        command: tmuxCmd,
        message: `Consola TUI de Antigravity (agy) lanzada en sesión tmux '${sessionName}'. Conéctate con: tmux attach -t ${sessionName}`,
      };
    } catch (err) {
      return {
        ok: false,
        terminal: "tmux",
        cwd,
        command: tmuxCmd,
        message: "Fallo al lanzar en tmux",
        error: (err as Error).message,
      };
    }
  }

  return {
    ok: false,
    terminal: "none",
    cwd,
    command: [],
    message: "No se encontró ningún emulador de terminal ni tmux disponible para desplegar la TUI.",
    error: "no_terminal_available",
  };
}
