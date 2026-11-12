// src/tui-launcher.ts — Spawner de consolas TUI de Antigravity (agy) en terminales de escritorio o tmux.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { openBridgeMonitorStack } from "./remote-monitor";
import { buildAgentBootstrapProtocol } from "./agent-protocol";
import { consolesDir, createConsole, setLaunchInfo, wrapperArgv, type NewConsole } from "./console-registry";
import { agentArgv, agentIds, findAgentBinary, resolveAgentTui } from "./agent-tuis";
import { consoleTmuxSocket } from "./console-delivery";

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
  consoleId?: string;
  tokenFp?: string;
  logPath?: string;
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

  // Identidad determinista de la consola (solo si realmente se lanza).
  let consoleInfo: NewConsole | null = null;
  const finalPromptHolder: { value?: string } = {};
  const basePrompt = options.prompt.trim();
  const workspaceId = options.workspaceId || "isy-mcp-workspace";

  if (!options.dryRun) {
    try {
      const { db } = openBridgeMonitorStack();
      const now = Date.now();
      try {
        consoleInfo = createConsole(db, { taskId, operationId, title, cwd, workspaceId, now });
      } catch (regErr) {
        console.error(`[tui-launcher:warn] No se pudo crear identidad de consola: ${String(regErr)}`);
      }
      const hintPrompt = options.includeMonitorHint ?? true
        ? `${basePrompt}\n\n${buildAgentBootstrapProtocol({ taskId, operationId, monitorUrl, isymcpCliPath, consoleId: consoleInfo?.console_id })}`
        : basePrompt;
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
        taskId, operationId, `tui-${taskId}`, "GOAL-002",
        consoleInfo ? `console:${consoleInfo.console_id}` : "chatgpt-tui-spawn",
        "lease-local-tui", workspaceId, "interactive_agent",
        hintPrompt.slice(0, 500), JSON.stringify(["tui:spawn", "status:read", "report:write"]),
        cwd, 1, "RUNNING", "tui_session_spawned", null, null, 1, now, now, null, null, now,
      );
      db.close();
      finalPromptHolder.value = hintPrompt;
    } catch (dbErr) {
      console.error(`[tui-launcher:warn] No se pudo registrar task en monitor: ${String(dbErr)}`);
    }
  }
  const finalPrompt = finalPromptHolder.value ?? (
    (options.includeMonitorHint ?? true)
      ? `${basePrompt}\n\n${buildAgentBootstrapProtocol({ taskId, operationId, monitorUrl, isymcpCliPath })}`
      : basePrompt
  );

  const recordLaunch = (info: { launcherPid?: number; terminal: string; tmuxSession?: string }) => {
    if (!consoleInfo) return;
    try {
      const { db } = openBridgeMonitorStack();
      try { setLaunchInfo(db, consoleInfo.console_id, info); } finally { db.close(); }
    } catch (e) {
      console.error(`[tui-launcher:warn] No se pudo registrar lanzamiento de consola: ${String(e)}`);
    }
  };
  const wrap = (inner: string[]): string[] => (consoleInfo ? wrapperArgv(consoleInfo, { taskId, operationId, monitorUrl }, inner) : inner);
  const consoleFields = () => (consoleInfo
    ? { consoleId: consoleInfo.console_id, tokenFp: consoleInfo.token_fp, logPath: consoleInfo.log_path }
    : {});

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
        ...wrap([agyBin, ...agyArgs]),
      ];
    } else {
      // x-terminal-emulator o xterm
      termCmd = [
        guiTerm,
        "-T", title,
        "-e",
        wrap([agyBin, ...agyArgs]).map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "),
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
      recordLaunch({ launcherPid: child.pid, terminal: guiTerm });

      return {
        ok: true,
        ...consoleFields(),
        pid: child.pid,
        terminal: guiTerm,
        cwd,
        command: termCmd,
        taskId,
        operationId,
        monitorUrl,
        state: "RUNNING",
        message: `Consola TUI de Antigravity (agy) lanzada exitosamente en ventana visible (${guiTerm}) con launcher_pid ${child.pid} (el PID real de agy se registra al arrancar: consulta tui.consoles) vinculada a la tarea ${taskId} y a la consola ${consoleInfo?.console_id ?? "n/a"}.`,
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
      ...wrap([agyBin, ...agyArgs]),
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
      recordLaunch({ launcherPid: child.pid, terminal: "tmux", tmuxSession: sessionName });

      return {
        ok: true,
        ...consoleFields(),
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

// ─── Multiharness: cualquier TUI del catálogo (src/agent-tuis.ts) ───────────
//
// agy conserva su ruta histórica (spawnAgyTui). El resto corre SIEMPRE en una
// sesión del socket tmux dedicado (consoleTmuxSocket()) —para que ISyMCP pueda
// entregarle tareas nuevas— y, si hay escritorio, se abre además una ventana
// de terminal adjunta a esa sesión (la ves igual que la de agy).

export interface SpawnAgentOptions extends SpawnAgyOptions {
  /** id o alias del catálogo (agy, claude, opencode, openisy, codex, gemini, copilot, droid, kimi, crush, hermes, openclaw). */
  agent?: string;
}

export type SpawnAgentResult = SpawnAgyResult & { agent: string; listener?: string; tmuxSocket?: string; tmuxSession?: string };

const shQuote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

export async function spawnAgentTui(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
  const def = resolveAgentTui(options.agent);
  const cwd = options.cwd || process.cwd();
  const fail = (error: string, message: string, extra: Partial<SpawnAgentResult> = {}): SpawnAgentResult => ({
    ok: false, terminal: "none", cwd, command: [], agent: def?.id ?? String(options.agent), error, message, ...extra,
  });
  if (!def) return fail("unknown_agent", `Agente desconocido: '${options.agent}'. Disponibles: ${agentIds().join(", ")}`);
  if (def.id === "agy") return { ...(await spawnAgyTui(options)), agent: "agy", listener: def.listener };
  if (options.dangerouslySkipPermissions === true) {
    return fail("skip_permissions_agy_only", `dangerously_skip_permissions solo existe para agy; ${def.label} pide permisos como siempre.`);
  }
  const bin = findAgentBinary(def);
  if (!bin) return fail("agent_not_installed", `${def.label} no está instalado (busqué: ${def.executables.join(", ")}).`);
  if (!existsSync("/usr/bin/tmux") && !Bun.which("tmux")) {
    return fail("tmux_missing", `${def.label} necesita tmux para recibir tareas de ChatGPT (instala tmux).`);
  }

  const title = options.title || `${def.label} — [ISyMCP Dispatch]`;
  const taskId = options.taskId || `task-tui-${randomBytes(6).toString("hex")}`;
  const operationId = options.operationId || `op-tui-${Date.now().toString(36)}`;
  const monitorUrl = process.env.ISYMCP_MONITOR_URL || "http://127.0.0.1:8799";
  const isymcpCliPath = joinPath(import.meta.dir, "isymcp.ts");
  const workspaceId = options.workspaceId || "isy-mcp-workspace";
  const basePrompt = options.prompt.trim();
  const withHint = options.includeMonitorHint ?? true;
  const socket = consoleTmuxSocket();

  let consoleInfo: NewConsole | null = null;
  let finalPrompt = withHint
    ? `${basePrompt}\n\n${buildAgentBootstrapProtocol({ taskId, operationId, monitorUrl, isymcpCliPath, agentLabel: def.label, listener: def.listener })}`
    : basePrompt;

  if (!options.dryRun) {
    try {
      const { db } = openBridgeMonitorStack();
      try {
        const now = Date.now();
        consoleInfo = createConsole(db, { taskId, operationId, title, cwd, workspaceId, now, agent: def.id });
        if (withHint) {
          finalPrompt = `${basePrompt}\n\n${buildAgentBootstrapProtocol({
            taskId, operationId, monitorUrl, isymcpCliPath, consoleId: consoleInfo.console_id, agentLabel: def.label, listener: def.listener,
          })}`;
        }
        db.query(`
          INSERT INTO tasks (
            task_id, operation_id, idempotency_key, goal_id, conversation_ref,
            lease_id, workspace_id, kind, description, requested_actions_json,
            target_relpath, idempotent, state, reason, grant_id, worker_lease_id,
            attempt_count, created_at, updated_at, result_json, receipt_hmac
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET state = 'RUNNING', reason = 'tui_session_spawned', updated_at = ?
        `).run(
          taskId, operationId, `tui-${taskId}`, "GOAL-002", `console:${consoleInfo.console_id}`,
          "lease-local-tui", workspaceId, "interactive_agent",
          finalPrompt.slice(0, 500), JSON.stringify(["tui:spawn", "status:read", "report:write"]),
          cwd, 1, "RUNNING", "tui_session_spawned", null, null, 1, now, now, null, null, now,
        );
      } finally {
        db.close();
      }
    } catch (e) {
      // Sin registro no hay identidad ni entrega de tareas: no se lanza a ciegas.
      return fail("monitor_unavailable", `No se pudo registrar la consola en el monitor: ${String(e)}`, { taskId, operationId, monitorUrl });
    }
  }

  const session = `${def.id}-${consoleInfo ? consoleInfo.console_id.slice(4) : "dryrun"}`;
  const inner = agentArgv(def, bin, finalPrompt, { mode: options.mode });
  const wrapped = consoleInfo ? wrapperArgv(consoleInfo, { taskId, operationId, monitorUrl }, inner) : inner;
  const tmuxCmd = ["tmux", "-L", socket, "new-session", "-d", "-s", session, "-x", "220", "-y", "50", "-c", cwd, ...wrapped];
  const pref = options.terminalPreference || "auto";
  const guiTerm = detectTerminalEmulator();
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const attach = ["tmux", "-L", socket, "attach", "-t", session];
  const guiCmd = guiTerm && hasDisplay && pref !== "tmux"
    ? guiTerm.includes("gnome-terminal")
      ? [guiTerm, `--title=${title}`, `--working-directory=${cwd}`, "--", ...attach]
      : [guiTerm, "-T", title, "-e", attach.map(shQuote).join(" ")]
    : null;
  const base = { cwd, taskId, operationId, monitorUrl, agent: def.id, listener: def.listener, tmuxSocket: socket, tmuxSession: session };

  if (options.dryRun) {
    return {
      ok: true, pid: 0, terminal: guiCmd ? `${guiTerm}+tmux` : "tmux", command: tmuxCmd, state: "PREPARED", ...base,
      message: `Dry-run: comando preparado exitosamente sin spawn real (${def.label}, listener ${def.listener}${def.promptVia === "inject" ? ", prompt inicial por pegado" : ""}).`,
    };
  }

  const started = Bun.spawnSync(tmuxCmd, { cwd, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  if (started.exitCode !== 0) {
    const err = started.stderr ? new TextDecoder().decode(started.stderr).trim().slice(0, 300) : "";
    return fail("tmux_start_failed", `tmux no pudo crear la sesión ${session}: ${err}`, { ...base, terminal: "tmux", command: tmuxCmd });
  }

  if (def.promptVia === "inject") {
    // La TUI no acepta prompt por argv: se pega cuando ya arrancó. Proceso aparte para sobrevivir al CLI.
    const promptFile = join(consolesDir(), `${consoleInfo!.console_id}.prompt`);
    writeFileSync(promptFile, finalPrompt, { mode: 0o600 });
    const t = ["tmux", "-L", socket];
    const script = `sleep ${Math.ceil((def.injectDelayMs ?? 5000) / 1000)}; ${t.join(" ")} load-buffer -b ib-${session} "$1" && ${t.join(" ")} paste-buffer -p -d -b ib-${session} -t ${session} && ${t.join(" ")} send-keys -t ${session} Enter; rm -f "$1"`;
    spawn("bash", ["-c", script, "isymcp-inject", promptFile], { detached: true, stdio: "ignore" }).unref();
  }

  let launcherPid: number | undefined;
  let terminal = `tmux:${socket}`;
  if (guiCmd) {
    try {
      const child = spawn(guiCmd[0]!, guiCmd.slice(1), { cwd, detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" } });
      child.unref();
      launcherPid = child.pid;
      terminal = `${guiTerm}+tmux:${socket}`;
    } catch {
      /* la sesión tmux sigue viva aunque no se abra la ventana */
    }
  }
  if (consoleInfo) {
    try {
      const { db } = openBridgeMonitorStack();
      try { setLaunchInfo(db, consoleInfo.console_id, { launcherPid, terminal, tmuxSession: session, tmuxSocket: socket }); } finally { db.close(); }
    } catch (e) {
      console.error(`[tui-launcher:warn] No se pudo registrar lanzamiento de consola: ${String(e)}`);
    }
  }
  return {
    ok: true, ...base, pid: launcherPid ?? 0, terminal, command: tmuxCmd, state: "RUNNING",
    consoleId: consoleInfo?.console_id, tokenFp: consoleInfo?.token_fp, logPath: consoleInfo?.log_path,
    message: `Consola ${def.label} lanzada en tmux '${session}' (socket ${socket})${guiCmd ? " con ventana visible" : ""}, tarea ${taskId}, consola ${consoleInfo?.console_id}. Ver: tmux -L ${socket} attach -t ${session}`,
  };
}
