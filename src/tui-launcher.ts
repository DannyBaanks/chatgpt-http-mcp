// src/tui-launcher.ts — Spawner de consolas TUI de Antigravity (agy) en terminales de escritorio o tmux.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { openBridgeMonitorStack } from "./remote-monitor";
import { buildAgentBootstrapProtocol } from "./agent-protocol";

export interface SpawnAgyOptions {
  prompt: string;
  cwd?: string;
  title?: string;
  mode?: "auto" | "plan" | "accept-edits";
  dangerouslySkipPermissions?: boolean;
  terminalPreference?: "auto" | "gui" | "tmux";
  includeMonitorHint?: boolean;
  dryRun?: boolean;
  taskId?: string;
  operationId?: string;
  workspaceId?: string;
}

export interface SpawnAgyResult {
  ok: boolean;
  pid?: number;
  terminal: string;
  cwd: string;
  command: string[];
  message: string;
  error?: string;
  taskId?: string;
  operationId?: string;
  monitorUrl?: string;
  state?: string;
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
  const skipPerms = options.dangerouslySkipPermissions === true;
  const pref = options.terminalPreference || "auto";

  const taskId = options.taskId || `task-tui-${randomBytes(6).toString("hex")}`;
  const operationId = options.operationId || `op-tui-${Date.now().toString(36)}`;
  const monitorUrl = process.env.ISYMCP_MONITOR_URL || "http://127.0.0.1:8799";
  const isymcpCliPath = joinPath(import.meta.dir, "isymcp.ts");

  let finalPrompt = options.prompt.trim();
  if (options.includeMonitorHint ?? true) {
    finalPrompt += `\n\n${buildAgentBootstrapProtocol({
      taskId,
      operationId,
      monitorUrl,
      isymcpCliPath,
    })}`;
  }

  // Si no es dryRun, auto-registramos la tarea en el monitor de ISyMCP
  if (!options.dryRun) {
    try {
      const { db } = openBridgeMonitorStack();
      const now = Date.now();
      db.query(`
        INSERT INTO tasks (
          task_id, operation_id, idempotency_key, goal_id, conversation_ref,
          lease_id, workspace_id, kind, description, requested_actions_json,
          target_relpath, idempotent, state, reason, grant_id, worker_lease_id,
          attempt_count, created_at, updated_at, result_json, receipt_hmac
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          state = 'RUNNING',
          reason = 'tui_session_spawned',
          updated_at = ?
      `).run(
        taskId,
        operationId,
        `tui-${taskId}`,
        "GOAL-002",
        "chatgpt-tui-spawn",
        "lease-local-tui",
        options.workspaceId || "isy-mcp-workspace",
        "interactive_agent",
        finalPrompt.slice(0, 500),
        JSON.stringify(["tui:spawn", "status:read", "report:write"]),
        cwd,
        1,
        "RUNNING",
        "tui_session_spawned",
        null,
        null,
        1,
        now,
        now,
        null,
        null,
        now,
      );
      db.close();
    } catch (dbErr) {
      console.error(`[tui-launcher:warn] No se pudo registrar task en monitor: ${String(dbErr)}`);
    }
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
      ? ["tmux", "new-session", "-d", "-s", "agy_dryrun", "-c", cwd, agyBin, ...agyArgs]
      : [guiTerm || "terminal", "--title", title, "--", agyBin, ...agyArgs];
    return {
      ok: true,
      pid: 0,
      terminal: targetTerm,
      cwd,
      command: previewCmd,
      taskId,
      operationId,
      monitorUrl,
      state: "PREPARED",
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
          ISYMCP_TASK_ID: taskId,
          ISYMCP_OPERATION_ID: operationId,
          ISYMCP_MONITOR_URL: monitorUrl,
        },
      });

      if (child.exitCode !== null) {
        return {
          ok: false,
          terminal: guiTerm,
          cwd,
          command: termCmd,
          taskId,
          operationId,
          monitorUrl,
          message: `Terminal falló al iniciar inmediatamente (código de salida: ${child.exitCode}).`,
          error: "process_early_exit",
        };
      }
      child.unref();

      return {
        ok: true,
        pid: child.pid,
        terminal: guiTerm,
        cwd,
        command: termCmd,
        taskId,
        operationId,
        monitorUrl,
        state: "RUNNING",
        message: `Consola TUI de Antigravity (agy) lanzada exitosamente en ventana visible (${guiTerm}) con PID ${child.pid} vinculada a la tarea ${taskId} en el monitor.`,
      };
    } catch (err) {
      return {
        ok: false,
        terminal: guiTerm,
        cwd,
        command: termCmd,
        taskId,
        operationId,
        monitorUrl,
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
      agyBin,
      ...agyArgs,
    ];

    try {
      const child = spawn(tmuxCmd[0], tmuxCmd.slice(1), {
        cwd,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ISYMCP_TASK_ID: taskId,
          ISYMCP_OPERATION_ID: operationId,
          ISYMCP_MONITOR_URL: monitorUrl,
        },
      });

      if (child.exitCode !== null) {
        return {
          ok: false,
          terminal: "tmux",
          cwd,
          command: tmuxCmd,
          taskId,
          operationId,
          monitorUrl,
          message: `tmux falló al iniciar sesión (código de salida: ${child.exitCode}).`,
          error: "tmux_early_exit",
        };
      }
      child.unref();

      return {
        ok: true,
        pid: child.pid,
        terminal: "tmux",
        cwd,
        command: tmuxCmd,
        taskId,
        operationId,
        monitorUrl,
        state: "RUNNING",
        message: `Consola TUI de Antigravity (agy) lanzada en sesión tmux '${sessionName}' vinculada a la tarea ${taskId} en el monitor. Conéctate con: tmux attach -t ${sessionName}`,
      };
    } catch (err) {
      return {
        ok: false,
        terminal: "tmux",
        cwd,
        command: tmuxCmd,
        taskId,
        operationId,
        monitorUrl,
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
    taskId,
    operationId,
    monitorUrl,
    message: "No se encontró ningún emulador de terminal ni tmux disponible para desplegar la TUI.",
    error: "no_terminal_available",
  };
}
