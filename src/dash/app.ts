import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../cli/root";
import { confirmationText, keyToAction, resolveConfirmation, type CommandAction, type DashAction } from "./keys";
import { renderFrame } from "./render";
import type { DashProvider, DashState, HubJson, StatusJson } from "./types";

const CLI = join(ROOT, "src", "isymcp.ts");
const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeText(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
}

function redactSecrets(value: string): string {
  return safeText(value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTADO]")
    .replace(/(["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTADO]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTADO]")
    .replace(/\btunnel_[a-f0-9]{32}\b/gi, "[REDACTADO]");
}

function parseJson<T>(out: string): T | null {
  try {
    return JSON.parse(out.trim()) as T;
  } catch {
    return null;
  }
}

async function spawnCaptured(args: string[], timeoutMs = 0): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const child = Bun.spawn(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    // Las lecturas periódicas llevan tope: un subproceso colgado no debe congelar el refresco.
    const killer = timeoutMs > 0 ? setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ya salió */ } }, timeoutMs) : null;
    if (killer) child.exited.finally(() => clearTimeout(killer));
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 1, stdout: "", stderr: errorText(error) };
  }
}

async function spawnText(args: string[]): Promise<{ code: number; out: string }> {
  const result = await spawnCaptured(args);
  return {
    code: result.code,
    out: `${result.stdout}${result.stderr ? `${result.stdout && !result.stdout.endsWith("\n") ? "\n" : ""}${result.stderr}` : ""}`,
  };
}

export const defaultDashProvider: DashProvider = {
  async status(): Promise<StatusJson | null> {
    const result = await spawnCaptured([process.execPath, CLI, "status", "--json"], 15_000);
    return result.code === 0 ? parseJson<StatusJson>(result.stdout) : null;
  },
  async hub(): Promise<HubJson | null> {
    const result = await spawnCaptured([process.execPath, CLI, "hub", "status", "--json"], 15_000);
    return result.code === 0 ? parseJson<HubJson>(result.stdout) : null;
  },
  async run(args: string[]): Promise<{ code: number; out: string }> {
    if (args[0] === "systemctl") return spawnText(args);
    return spawnText([process.execPath, CLI, ...args]);
  },
};

export function createInitialState(now = Date.now()): DashState {
  return {
    status: null,
    hub: null,
    now,
    message: "",
    busy: false,
    spinner: 0,
    showLog: false,
    showHelp: false,
    logLines: [],
    loaded: false,
  };
}

/** Lee los dos contratos en paralelo. Cada fuente puede fallar sin tumbar el frame. */
export async function readDashSnapshot(provider: DashProvider): Promise<{ status: StatusJson | null; hub: HubJson | null }> {
  const [status, hub] = await Promise.all([
    provider.status().catch(() => null),
    provider.hub().catch(() => null),
  ]);
  return { status, hub };
}

export async function readHubLogTail(maxLines: number): Promise<string[]> {
  const path = process.env.ISYMCP_HUB_LOG?.trim() || join(homedir(), ".codex-web-http", "hub", "hub.log");
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    const length = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, Math.max(0, stat.size - length));
    return redactSecrets(buffer.toString("utf8")).split(/\r?\n/).filter(Boolean).slice(-Math.max(0, maxLines));
  } catch {
    return [`No se pudo leer log: ${path}`];
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function terminalSize(): { width: number; height: number } {
  return { width: process.stdout.columns || 80, height: process.stdout.rows || 24 };
}

function writeFrame(state: DashState, fullClear = false): void {
  const { width, height } = terminalSize();
  const body = renderFrame(state, width, height)
    .split("\n")
    .map((line) => `${line}\x1b[K`)
    .join("\n");
  // Redibujar en sitio sin \x1b[2J evita parpadeo; solo limpiamos entero al arrancar o redimensionar.
  process.stdout.write(`${SYNC_START}${fullClear ? "\x1b[H\x1b[2J" : "\x1b[H"}${body}\x1b[0J${SYNC_END}`);
}

function commandSummary(action: CommandAction, result: { code: number; out: string }): string {
  const output = redactSecrets(result.out).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-2).join(" · ");
  const status = result.code === 0 ? "OK" : `FALLO rc=${result.code}`;
  return `${action.label}: ${status}${output ? ` · ${output}` : ""}`;
}

function runProviderAction(provider: DashProvider, action: CommandAction, state: DashState, draw: () => void): void {
  if (state.busy) {
    state.message = "Hay una acción en curso; espera a que termine.";
    draw();
    return;
  }
  state.busy = true;
  state.message = `Ejecutando ${action.label}…`;
  draw();
  void provider.run(action.args).then((result) => {
    state.message = commandSummary(action, result);
  }).catch((error) => {
    state.message = `${action.label}: FALLO · ${redactSecrets(errorText(error))}`;
  }).finally(async () => {
    state.busy = false;
    state.now = Date.now();
    const snapshot = await readDashSnapshot(provider);
    state.status = snapshot.status;
    state.hub = snapshot.hub;
    draw();
  });
}

function handleAction(
  action: DashAction,
  state: DashState,
  provider: DashProvider,
  draw: () => void,
  finish: () => void,
  pending: { value: CommandAction | null },
): void {
  if (action.kind === "exit") {
    finish();
    return;
  }
  if (action.kind === "help") {
    state.showHelp = !state.showHelp;
    state.showLog = false;
    state.message = state.showHelp ? "Ayuda de teclas" : "";
    draw();
    return;
  }
  if (action.kind === "logs") {
    state.showLog = !state.showLog;
    state.showHelp = false;
    state.message = state.showLog ? "Log del hub · l vuelve al panel" : "Vista de estado";
    if (state.showLog) {
      const { height } = terminalSize();
      void readHubLogTail(Math.max(1, height - 5)).then((lines) => {
        state.logLines = lines;
        draw();
      });
    }
    draw();
    return;
  }

  const prompt = confirmationText(action);
  if (prompt) {
    pending.value = action;
    state.message = `¿${prompt}? Pulsa solo y para confirmar; otra tecla cancela.`;
    draw();
    return;
  }
  runProviderAction(provider, action, state, draw);
}

function handleInputKey(
  key: string,
  state: DashState,
  provider: DashProvider,
  draw: () => void,
  finish: () => void,
  pending: { value: CommandAction | null },
): void {
  if (pending.value) {
    const action = pending.value;
    pending.value = null;
    const confirmed = resolveConfirmation(action, key);
    if (confirmed) runProviderAction(provider, confirmed, state, draw);
    else {
      state.message = `${action.label}: cancelado`;
      draw();
    }
    return;
  }
  const action = keyToAction(key);
  if (action) handleAction(action, state, provider, draw, finish, pending);
}

function splitInputKeys(onKey: (key: string) => void): (chunk: string | Buffer) => void {
  let escape: "none" | "start" | "sequence" = "none";
  return (chunk) => {
    for (const char of String(chunk)) {
      if (escape === "start") {
        if (char === "[" || char === "O") escape = "sequence";
        else {
          escape = "none";
          onKey("escape");
          onKey(char);
        }
        continue;
      }
      if (escape === "sequence") {
        if (char >= "@" && char <= "~") escape = "none";
        continue;
      }
      if (char === "\x1b") {
        escape = "start";
        onKey("escape");
      } else if (char === "\x03") {
        onKey("ctrl-c");
      } else if (char === "\r" || char === "\n") {
        onKey("enter");
      } else if (char === "\x7f" || char === "\b") {
        onKey("backspace");
      } else if (char >= " ") {
        onKey(char);
      }
    }
  };
}

export async function runDash(provider: DashProvider = defaultDashProvider, options: { once?: boolean } = {}): Promise<void> {
  const state = createInitialState();
  if (options.once || !process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    const snapshot = await readDashSnapshot(provider);
    state.status = snapshot.status;
    state.hub = snapshot.hub;
    state.now = Date.now();
    state.loaded = true;
    process.stdout.write(`${renderFrame(state, process.stdout.columns || 80, process.stdout.rows || 24)}\n`);
    return;
  }

  const input = process.stdin;
  let resolveExit!: () => void;
  const done = new Promise<void>((resolve) => { resolveExit = resolve; });
  let finished = false;
  let alternateScreen = false;
  let rawMode = false;
  let refreshInFlight = false;
  let pendingRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  const pending = { value: null as CommandAction | null };
  const finish = () => {
    if (finished) return;
    finished = true;
    resolveExit();
  };
  const draw = () => { if (!finished) writeFrame(state); };

  const refresh = async () => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const snapshot = await readDashSnapshot(provider);
      state.status = snapshot.status;
      state.hub = snapshot.hub;
      state.now = Date.now();
      state.loaded = true;
      if (state.showLog) {
        const { height } = terminalSize();
        state.logLines = await readHubLogTail(Math.max(1, height - 5));
      }
    } finally {
      refreshInFlight = false;
      draw();
    }
  };

  const onKey = (key: string) => handleInputKey(key, state, provider, draw, finish, pending);
  const onData = splitInputKeys(onKey);
  const onResize = () => { if (!finished) writeFrame(state, true); };
  const onSignal = () => finish();

  // Si un error no capturado mata el proceso, `finally` no corre: restaura la terminal en 'exit'.
  const onExit = () => {
    if (rawMode) { try { input.setRawMode(false); } catch { /* stdin cerrado */ } }
    if (alternateScreen) { try { process.stdout.write(`\x1b[0m${SHOW_CURSOR}${ALT_SCREEN_OFF}`); } catch { /* stdout cerrado */ } }
  };
  try {
    process.once("exit", onExit);
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    input.setEncoding("utf8");
    input.setRawMode(true);
    rawMode = true;
    input.on("data", onData);
    input.resume();
    alternateScreen = true;
    process.stdout.write(`${ALT_SCREEN_ON}${HIDE_CURSOR}`);
    writeFrame(state, true);
    void refresh();
    pendingRefreshTimer = setInterval(() => { void refresh(); }, 3000);
    spinnerTimer = setInterval(() => {
      if (state.busy) {
        state.spinner++;
        draw();
      }
    }, 120);
    process.stdout.on("resize", onResize);
    await done;
  } finally {
    if (pendingRefreshTimer) clearInterval(pendingRefreshTimer);
    if (spinnerTimer) clearInterval(spinnerTimer);
    input.off("data", onData);
    process.stdout.off("resize", onResize);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("exit", onExit);
    if (rawMode) {
      try { input.setRawMode(false); } catch { /* stdin may already be closed */ }
    }
    input.pause();
    if (alternateScreen) process.stdout.write(`\x1b[0m${SHOW_CURSOR}${ALT_SCREEN_OFF}`);
  }
}
