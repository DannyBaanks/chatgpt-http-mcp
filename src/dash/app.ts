import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../cli/root";
import { logSources } from "../logs";
import { commandForKey, confirmationText, keyToAction, resolveConfirmation, type Confirmable, type CommandAction, type DashAction } from "./keys";
import { paletteAction, rowCount, viewKeyAction } from "./ops";
import { renderFrame } from "./render";
import { VIEWS, type CommandOutput, type DashProvider, type DashState, type HubJson, type LogSource, type MonitorTask, type StatusJson } from "./types";

const CLI = join(ROOT, "src", "isymcp.ts");
const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

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

async function spawnText(args: string[], timeoutMs = 0): Promise<{ code: number; out: string }> {
  const result = await spawnCaptured(args, timeoutMs);
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
  async run(args: string[], timeoutMs = 0): Promise<{ code: number; out: string }> {
    if (args[0] === "systemctl") return spawnText(args, timeoutMs);
    return spawnText([process.execPath, CLI, ...args], timeoutMs);
  },
  async monitorTasks(): Promise<MonitorTask[] | null> {
    const result = await spawnCaptured([process.execPath, CLI, "monitor", "tasks", "--json"], 15_000);
    if (result.code !== 0) return null;
    const parsed = parseJson<MonitorTask[]>(result.stdout);
    return Array.isArray(parsed) ? parsed : result.stdout.includes("sin tareas") ? [] : null;
  },
  async logs(source: LogSource, maxLines: number): Promise<string[]> {
    if (source === "hub") return readHubLogTail(maxLines);
    const path = logSources().find((s) => s.name === source)?.path;
    return path ? readTail(path, maxLines) : [`fuente desconocida: ${source}`];
  },
  async open(url: string): Promise<void> {
    // Solo http(s): el valor viene de archivos de estado, nunca se pasa a una shell.
    if (!/^https?:\/\//.test(url)) throw new Error(`URL no permitida: ${url}`);
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
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
    showHelp: false,
    loaded: false,
    view: "resumen",
    cursor: { resumen: 0, hub: 0, tareas: 0, sesiones: 0, logs: 0, salida: 0 },
    expanded: false,
    monitorTasks: null,
    logSource: "hub",
    logLines: [],
    logFilter: "",
    hideNoise: true,
    outputs: [],
    input: null,
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
  return readTail(process.env.ISYMCP_HUB_LOG?.trim() || join(homedir(), ".codex-web-http", "hub", "hub.log"), maxLines);
}

/** Últimas líneas de un archivo (lee como mucho 512 KiB del final), con secretos tapados. */
export async function readTail(path: string, maxLines: number): Promise<string[]> {
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    const length = Math.min(stat.size, 512 * 1024);
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

function writeFrame(state: DashState): void {
  const { width, height } = terminalSize();
  process.stdout.write(`\x1b[H\x1b[2J${renderFrame(state, width, height)}`);
}

const MAX_OUTPUTS = 20;
const OUTPUT_LINES = 200;

function commandSummary(label: string, result: { code: number; out: string }): string {
  const output = redactSecrets(result.out).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-1).join("");
  const status = result.code === 0 ? "OK" : `FALLO rc=${result.code}`;
  return `${label}: ${status}${output ? ` · ${output}` : ""} · 6 salida completa`;
}

function recordOutput(state: DashState, cmd: string, result: { code: number; out: string }, ms: number): void {
  const lines = redactSecrets(result.out).split(/\r?\n/).filter((l) => l.trim() !== "");
  const entry: CommandOutput = { ts: Date.now(), cmd, code: result.code, ms, lines: lines.length > OUTPUT_LINES ? [`… (${lines.length - OUTPUT_LINES} líneas antes)`, ...lines.slice(-OUTPUT_LINES)] : lines };
  state.outputs = [...state.outputs, entry].slice(-MAX_OUTPUTS);
  state.cursor.salida = 0;
}

/** Contexto que comparten los manejadores de teclas. */
interface Ctx {
  state: DashState;
  provider: DashProvider;
  draw: () => void;
  finish: () => void;
  refresh: () => Promise<void>;
  pending: { value: Confirmable | null };
}

function runConfirmable(ctx: Ctx, action: Confirmable): void {
  const { state, provider, draw } = ctx;
  if (state.busy) {
    state.message = "Hay una acción en curso; espera a que termine.";
    draw();
    return;
  }
  state.busy = true;
  state.message = `Ejecutando ${action.label}…`;
  draw();
  const steps = action.kind === "batch" ? action.steps : [action.args];
  const timeout = action.kind === "command" && action.toOutput ? 120_000 : 0;
  void (async () => {
    let failed = 0;
    let last: { code: number; out: string } = { code: 0, out: "" };
    for (const args of steps) {
      const started = Date.now();
      try {
        last = await provider.run(args, timeout);
      } catch (error) {
        last = { code: 1, out: errorText(error) };
      }
      if (last.code !== 0) failed++;
      recordOutput(state, args[0] === "systemctl" ? args.join(" ") : `isymcp ${args.join(" ")}`, last, Date.now() - started);
    }
    state.message = action.kind === "batch"
      ? `${action.label}: ${steps.length - failed}/${steps.length} OK · 6 salida completa`
      : commandSummary(action.label, last);
    if (action.kind === "command" && action.toOutput) state.view = "salida";
  })().finally(async () => {
    // Tras reiniciar un MCP el hub tarda ~1 s en relanzarlo: leer antes mostraría "failed".
    if (steps.some((a) => a[0] === "hub" && a[1] === "restart")) await new Promise((r) => setTimeout(r, 1500));
    state.busy = false;
    await ctx.refresh().catch(() => undefined);
    draw();
  });
}

function askOrRun(ctx: Ctx, action: Confirmable): void {
  const prompt = confirmationText(action);
  if (prompt) {
    ctx.pending.value = action;
    ctx.state.message = `¿${prompt}? Pulsa y para confirmar; otra tecla cancela.`;
    ctx.draw();
    return;
  }
  runConfirmable(ctx, action);
}

function setView(ctx: Ctx, view: DashState["view"]): void {
  const { state } = ctx;
  state.view = view;
  state.showHelp = false;
  state.expanded = false;
  state.message = "";
  void ctx.refresh();
}

function handleAction(action: DashAction, ctx: Ctx): void {
  const { state, draw } = ctx;
  switch (action.kind) {
    case "exit": ctx.finish(); return;
    case "help": state.showHelp = !state.showHelp; draw(); return;
    case "view": setView(ctx, action.view); draw(); return;
    case "nextView": {
      const i = VIEWS.indexOf(state.view);
      setView(ctx, VIEWS[(i + action.dir + VIEWS.length) % VIEWS.length]!);
      draw();
      return;
    }
    case "move": {
      const v = state.view;
      if (v === "logs" || v === "salida") {
        // En las vistas de texto el cursor es el desplazamiento desde el final (↑ sube = más viejo).
        state.cursor[v] = Math.max(0, state.cursor[v] - action.delta);
      } else {
        const n = rowCount(state);
        state.cursor[v] = n === 0 ? 0 : Math.min(n - 1, Math.max(0, state.cursor[v] + action.delta));
      }
      draw();
      return;
    }
    case "toggleDetail": state.expanded = !state.expanded; draw(); return;
    case "logsFor":
      state.logSource = "hub";
      state.logFilter = action.filter;
      state.cursor.logs = 0;
      setView(ctx, "logs");
      draw();
      return;
    case "cycleLogSource": {
      const order: LogSource[] = ["hub", "server", "tunnel"];
      state.logSource = order[(order.indexOf(state.logSource) + 1) % order.length]!;
      state.cursor.logs = 0;
      void ctx.refresh();
      draw();
      return;
    }
    case "toggleNoise": state.hideNoise = !state.hideNoise; draw(); return;
    case "startInput":
      state.input = { mode: action.mode, text: action.mode === "filter" ? state.logFilter : "" };
      draw();
      return;
    case "open":
      if (!ctx.provider.open) { state.message = `abre a mano: ${action.url}`; draw(); return; }
      void ctx.provider.open(action.url).then(() => { state.message = `abierto en el navegador: ${action.url}`; })
        .catch((e) => { state.message = `no se pudo abrir: ${redactSecrets(errorText(e))}`; }).finally(draw);
      return;
    case "note": state.message = action.text; draw(); return;
    case "key": {
      const command = commandForKey(action.key);
      if (command) askOrRun(ctx, command);
      return;
    }
    case "command":
    case "batch":
      askOrRun(ctx, action);
      return;
  }
}

function handleInputLine(key: string, ctx: Ctx): void {
  const { state, draw } = ctx;
  const input = state.input!;
  if (key === "escape") {
    state.input = null;
    draw();
    return;
  }
  if (key === "enter") {
    state.input = null;
    if (input.mode === "filter") {
      state.logFilter = input.text.trim();
      state.cursor.logs = 0;
      draw();
    } else handleAction(paletteAction(input.text), ctx);
    return;
  }
  if (key === "backspace") input.text = input.text.slice(0, -1);
  else if (key === "ctrl-c") { state.input = null; }
  else if ([...key].length === 1) input.text += key;
  draw();
}

/**
 * Controlador de teclas sin terminal: lo usa runDash y los tests (teclas → acciones → provider).
 * `settled()` espera a que termine la acción en curso.
 */
export function dashController(state: DashState, provider: DashProvider, opts: { draw?: () => void; finish?: () => void } = {}) {
  let inflight: Promise<void> = Promise.resolve();
  const ctx: Ctx = {
    state,
    provider,
    draw: opts.draw ?? (() => undefined),
    finish: opts.finish ?? (() => undefined),
    refresh: () => (inflight = refreshView(state, provider).catch(() => undefined)),
    pending: { value: null },
  };
  return {
    key: (key: string) => handleInputKey(key, ctx),
    async settled(): Promise<void> {
      const deadline = Date.now() + 5_000;
      do { await inflight; await new Promise((r) => setTimeout(r, 10)); } while (state.busy && Date.now() < deadline);
      await inflight;
    },
  };
}

function handleInputKey(key: string, ctx: Ctx): void {
  const { state } = ctx;
  if (state.input) {
    handleInputLine(key, ctx);
    return;
  }
  if (ctx.pending.value) {
    const action = ctx.pending.value;
    ctx.pending.value = null;
    const confirmed = resolveConfirmation(action, key);
    if (confirmed) runConfirmable(ctx, confirmed);
    else {
      state.message = `${action.label}: cancelado`;
      ctx.draw();
    }
    return;
  }
  if (state.showHelp && key !== "q" && key !== "ctrl-c") {
    state.showHelp = false;
    ctx.draw();
    return;
  }
  if (key === "escape") {
    if (state.expanded) { state.expanded = false; ctx.draw(); }
    return;
  }
  const action = viewKeyAction(key, state) ?? keyToAction(key);
  if (action) handleAction(action, ctx);
}

const CSI_KEYS: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "backtab",
  "5~": "pageup", "6~": "pagedown", "1~": "home", "4~": "end", "7~": "home", "8~": "end",
};

/**
 * Bytes de la terminal a teclas con nombre. Las secuencias CSI/SS3 (flechas, PgUp/PgDn, Home/End,
 * Shift+Tab) se traducen; un ESC solo al final del bloque es la tecla Escape.
 */
export function splitInputKeys(onKey: (key: string) => void): (chunk: string | Buffer) => void {
  let escape: "none" | "start" | "sequence" = "none";
  let params = "";
  return (chunk) => {
    const chars = [...String(chunk)];
    chars.forEach((char, index) => {
      if (escape === "start") {
        if (char === "[" || char === "O") {
          escape = "sequence";
          params = "";
        } else {
          // Alt+tecla: se trata como la tecla sola.
          escape = "none";
          if (char === "\x1b") { onKey("escape"); escape = "start"; }
          else if (char >= " ") onKey(char);
        }
        if (escape === "start" && index === chars.length - 1) { escape = "none"; onKey("escape"); }
        return;
      }
      if (escape === "sequence") {
        if (char >= "@" && char <= "~") {
          escape = "none";
          const named = CSI_KEYS[char === "~" ? `${params.split(";")[0]}~` : char];
          if (named) onKey(named);
        } else params += char;
        return;
      }
      if (char === "\x1b") {
        if (index === chars.length - 1) onKey("escape");
        else escape = "start";
      } else if (char === "\x03") {
        onKey("ctrl-c");
      } else if (char === "\t") {
        onKey("tab");
      } else if (char === "\r" || char === "\n") {
        onKey("enter");
      } else if (char === "\x7f" || char === "\b") {
        onKey("backspace");
      } else if (char >= " ") {
        onKey(char);
      }
    });
  };
}

const REFRESH_MS = 4000;
/** Líneas de log que se cargan para poder desplazarse hacia atrás. */
const LOG_LINES = 2000;

/** Relee estado + hub y, según la vista, el buzón del monitor o el log. */
export async function refreshView(state: DashState, provider: DashProvider): Promise<void> {
  const needTasks = state.view === "tareas" || state.view === "resumen";
  const [snapshot, monitorTasks, logLines] = await Promise.all([
    readDashSnapshot(provider),
    needTasks && provider.monitorTasks ? provider.monitorTasks().catch(() => null) : Promise.resolve(undefined),
    state.view === "logs" && provider.logs ? provider.logs(state.logSource, LOG_LINES).catch((e) => [`no se pudo leer: ${errorText(e)}`]) : Promise.resolve(undefined),
  ]);
  state.status = snapshot.status;
  state.hub = snapshot.hub;
  state.now = Date.now();
  state.loaded = true;
  if (monitorTasks !== undefined) state.monitorTasks = monitorTasks;
  if (logLines !== undefined) state.logLines = logLines;
}

export async function runDash(provider: DashProvider = defaultDashProvider, options: { once?: boolean } = {}): Promise<void> {
  const state = createInitialState();
  if (options.once || !process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    const snapshot = await readDashSnapshot(provider);
    state.status = snapshot.status;
    state.hub = snapshot.hub;
    state.now = Date.now();
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
  const pending = { value: null as Confirmable | null };
  const finish = () => {
    if (finished) return;
    finished = true;
    resolveExit();
  };
  const draw = () => { if (!finished) writeFrame(state); };

  let refreshAgain = false;
  const refresh = async (): Promise<void> => {
    // Si ya hay una lectura en vuelo (p. ej. la periódica) y cambia la vista, se repite al
    // terminar: la vista nueva no espera al siguiente tick para cargar su log o sus tareas.
    if (refreshInFlight) { refreshAgain = true; return; }
    refreshInFlight = true;
    try {
      do {
        refreshAgain = false;
        await refreshView(state, provider);
        draw();
      } while (refreshAgain && !finished);
    } finally {
      refreshInFlight = false;
      draw();
    }
  };

  const ctx: Ctx = { state, provider, draw, finish, refresh, pending };
  const onKey = (key: string) => handleInputKey(key, ctx);
  const onData = splitInputKeys(onKey);
  const onResize = () => draw();
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
    draw();
    void refresh();
    pendingRefreshTimer = setInterval(() => { void refresh(); }, REFRESH_MS);
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
