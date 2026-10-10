#!/usr/bin/env bun
import { buildCodexArgs, installDesktopLauncher, isBridgeAlive, removeDesktopLauncher, usesWebBridge } from "./codex-launcher";
// isymcp — consola del bridge, y la UNICA entrada: en una terminal, `isymcp`
// a secas abre el menu con todo (panel, chat, ajustes, harnesses, canario...).
// Se puede cerrar: server y panel quedan detached.
//
//   isymcp                 menu (en TTY) / estado (sin TTY)
//   isymcp panel           abre el panel (lo levanta en background si hace falta)
//   isymcp ask "texto"     turno real con ChatGPT desde la terminal
//   isymcp up              server + tunel, en background
//   isymcp down            para server y tunel
//   isymcp server start|stop
//   isymcp tunnel connect|stop|status
//   isymcp models          dry-run del catalogo
//   isymcp models apply
//   isymcp models restore
//   isymcp command "texto"
import { spawn } from "node:child_process";
import readline from "node:readline";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bindCookies } from "./sessions";
import { bridgeHome, isExpired, listUserSessions, mintSession, revokeSession } from "./codex-sessions";
import { startPanel } from "./panel";
import { createChat, loadChat } from "./chats";
import { runHook } from "./hooks";
import { installWebModels } from "../scripts/install-web-models";
import { defaultExportPath, exportLines, formatLine, parseBound, readAll, selectLines } from "./logs";
import { MENU, brandHeader, findItem, select, visible, visibleLabels } from "./menu";
import { buildChatGPTCommand, CONNECTOR_NAME, MENTION } from "./mcp/identity";
import { detectTuis, installIntoOpencode } from "./tui";
import { bridgeAuthHeaders } from "./local-guard";

const ROOT = join(import.meta.dir, "..");
const PORT = process.env.CODEX_WEB_HTTP_PORT?.trim() || "8791";
const RUN = join(bridgeHome(), "run");
const SERVER_SUFFIX = PORT === "8791" ? "" : `-${PORT}`;
const PID = join(RUN, `server${SERVER_SUFFIX}.pid`);
const LOG = join(RUN, `server${SERVER_SUFFIX}.log`);
const PANEL_PID = join(RUN, "panel.pid");
const PANEL_LOG = join(RUN, "panel.log");
const PANEL_PORT = process.env.ISYMCP_PANEL_PORT?.trim() || "8798";
const PANEL_URL = `http://127.0.0.1:${PANEL_PORT}`;
const BRIDGE = `http://127.0.0.1:${PORT}`;

function sh(cmd: string[], timeout = 20_000): { code: number; out: string } {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout });
  return { code: proc.exitCode ?? 1, out: proc.stdout.toString() + proc.stderr.toString() };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file = PID): number | null {
  if (!existsSync(file)) return null;
  const n = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: bridgeAuthHeaders(), signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function startServer(options: { connector?: string | null } = {}): void {
  mkdirSync(RUN, { recursive: true });
  const existing = readPid();
  if (existing && alive(existing)) {
    console.log(`server ya corre (pid ${existing})`);
    return;
  }
  // Connector por defecto: el nombre publico del MCP (identity.ts). `null` lo
  // apaga; la env CODEX_WEB_HTTP_CONNECTOR lo sobreescribe.
  const connector = options.connector === null
    ? ""
    : (options.connector ?? process.env.CODEX_WEB_HTTP_CONNECTOR ?? CONNECTOR_NAME);
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    CODEX_WEB_HTTP_WEB_MODELS: process.env.CODEX_WEB_HTTP_WEB_MODELS ?? "on",
    CODEX_WEB_HTTP_PORT: PORT,
    // No se asume Pro: el catalogo solo anuncia lo verificable (web-models.ts).
    CODEX_WEB_HTTP_CAPS: process.env.CODEX_WEB_HTTP_CAPS ?? "sol",
  };
  if (connector) childEnv.CODEX_WEB_HTTP_CONNECTOR = connector;
  else delete childEnv.CODEX_WEB_HTTP_CONNECTOR;
  const logFd = openSync(LOG, "a");
  const child = spawn("bun", ["run", join(ROOT, "src", "cli.ts")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: childEnv,
  });
  child.unref();
  writeFileSync(PID, `${child.pid}\n`);
  console.log(`server detached pid=${child.pid} log=${LOG} connector=${connector || "off"}`);
  console.log("puedes cerrar esta terminal: el server no depende de ella");
}

function stopServer(): void {
  const pid = readPid();
  if (pid && alive(pid)) {
    process.kill(pid, "SIGTERM");
    console.log(`server parado (pid ${pid})`);
  } else {
    console.log("server no estaba corriendo");
  }
  try {
    writeFileSync(PID, "");
  } catch {
    /* pid file opcional */
  }
}

// ── Panel en background ────────────────────────────────────────────────────
// Mismo patron que el server: proceso detached + pid file. `isymcp panel`
// lo levanta si hace falta y abre el navegador; cerrar la terminal no lo mata.

async function panelUp(): Promise<boolean> {
  try {
    const res = await fetch(`${PANEL_URL}/`, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startPanelDetached(): Promise<boolean> {
  if (await panelUp()) {
    console.log(`panel ya corre en ${PANEL_URL}`);
    return true;
  }
  mkdirSync(RUN, { recursive: true });
  const logFd = openSync(PANEL_LOG, "a");
  const child = spawn("bun", ["run", join(ROOT, "src", "isymcp.ts"), "panel", "run", "--port", PANEL_PORT], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, CODEX_WEB_HTTP_PORT: PORT },
  });
  child.unref();
  writeFileSync(PANEL_PID, `${child.pid}\n`);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await panelUp()) {
      console.log(`panel detached pid=${child.pid} ${PANEL_URL} log=${PANEL_LOG}`);
      return true;
    }
  }
  console.error(`el panel no respondio en 5 s; mira ${PANEL_LOG}`);
  return false;
}

function stopPanel(): void {
  const pid = readPid(PANEL_PID);
  if (pid && alive(pid)) {
    process.kill(pid, "SIGTERM");
    console.log(`panel parado (pid ${pid})`);
  } else {
    console.log("panel no estaba corriendo (o lo levantaste en primer plano: Ctrl+C alli)");
  }
  try { writeFileSync(PANEL_PID, ""); } catch { /* pid file opcional */ }
}

function openInBrowser(url: string): void {
  try {
    const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => console.log(`abre a mano: ${url}`));
    child.unref();
    console.log(`abriendo ${url}`);
  } catch {
    console.log(`abre a mano: ${url}`);
  }
}

async function openPanel(): Promise<void> {
  if (!(await serverUp())) console.log(`ojo: el server (:${PORT}) esta abajo; el panel abre igual y lo muestra. Levantalo con: isymcp up`);
  if (await startPanelDetached()) openInBrowser(PANEL_URL);
}

// ── Chat desde la terminal ─────────────────────────────────────────────────
// Usa el MISMO camino que el panel (POST /isymcp/chat/turn): un chat local =
// una conversacion real de chatgpt.com. El chat de la terminal se recuerda en
// run/cli-chat para que preguntas seguidas tengan contexto; --new empieza otro.

const CLI_CHAT = join(RUN, "cli-chat");

function cliChatId(fresh: boolean, firstMessage: string): string {
  if (!fresh && existsSync(CLI_CHAT)) {
    const id = readFileSync(CLI_CHAT, "utf8").trim();
    if (loadChat(id)) return id;
  }
  const chat = createChat(`[terminal] ${firstMessage.replace(/\s+/g, " ").slice(0, 60)}`);
  mkdirSync(RUN, { recursive: true });
  writeFileSync(CLI_CHAT, `${chat.id}\n`);
  return chat.id;
}

async function askChatGPT(message: string, fresh = false): Promise<boolean> {
  if (!message.trim()) {
    console.error("mensaje vacio");
    return false;
  }
  if (!(await serverUp())) {
    console.error(`el server no responde en ${BRIDGE}. Levantalo con: isymcp up`);
    return false;
  }
  const chatId = cliChatId(fresh, message);
  const started = Date.now();
  const tty = !!process.stderr.isTTY;
  const paint = (code: string, text: string) => (tty && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
  let shown = "";
  let phase = "";
  // Progreso en vivo (stderr): fase y texto parcial, como en el panel.
  const poll = setInterval(async () => {
    try {
      const st = (await (await fetch(`${BRIDGE}/isymcp/chat/status`, { signal: AbortSignal.timeout(1_500) })).json()) as {
        phase: string; chat_id: string | null; queued: number; partial?: string;
      };
      if (!tty) return;
      const mine = st.chat_id === chatId;
      const label = mine ? st.phase : st.queued > 0 ? "en cola (otro turno en curso)" : st.phase;
      if (label !== phase) {
        phase = label;
        process.stderr.write(`${paint("2", `· ${label} (${Math.round((Date.now() - started) / 1000)} s)`)}\n`);
      }
      if (mine && st.partial && st.partial.startsWith(shown) && st.partial.length > shown.length) {
        process.stderr.write(paint("2", st.partial.slice(shown.length)));
        shown = st.partial;
      }
    } catch { /* el poll es cosmetico */ }
  }, 700);
  try {
    const res = await fetch(`${BRIDGE}/isymcp/chat/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message }),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; reply?: { text?: string; meta?: { kind?: string; detail?: string } }; chat?: { conversation_url?: string | null }; error?: { type?: string; message?: string } }
      | null;
    clearInterval(poll);
    if (shown && tty) process.stderr.write(`\n${paint("2", "── respuesta final ──")}\n`);
    if (!res.ok || !body) {
      console.error(`error ${res.status}: ${body?.error?.type ?? ""} ${body?.error?.message ?? "respuesta ilegible"}`);
      return false;
    }
    console.log(body.reply?.text ?? "");
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!body.ok) console.error(paint("31", `✗ ${body.reply?.meta?.kind ?? "error"} · ${body.reply?.meta?.detail ?? ""}`));
    console.error(paint("2", `${body.ok ? "✓" : "✗"} ${secs} s · chat ${chatId} · ${body.chat?.conversation_url ?? "sin /c/"} · sigue en el panel`));
    return body.ok === true;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    clearInterval(poll);
  }
}

// ── Ajustes de ChatGPT (modelo/reasoning de la cuenta) ─────────────────────

async function bridgeJson(path: string, method = "GET"): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${BRIDGE}${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    body: method === "POST" ? "{}" : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

function describeSeen(seen: unknown): string {
  const s = seen as { model?: string | null; effort?: string | null; effortPosition?: number | null; effortSteps?: number | null; at?: string } | null;
  if (!s) return "(sin lectura todavia)";
  const pos = s.effortPosition && s.effortSteps ? ` (${s.effortPosition}/${s.effortSteps})` : "";
  return `${s.model ?? "?"} · ${s.effort ?? "?"}${pos}${s.at ? ` · ${s.at}` : ""}`;
}

async function settingsVerify(): Promise<void> {
  if (!(await serverUp())) { console.error("el server esta abajo: isymcp up"); return; }
  console.log("leyendo el selector del headless (solo lectura, ~10 s)…");
  const r = await bridgeJson("/isymcp/settings/verify", "POST");
  if (r.status !== 200) {
    console.error(`no se pudo verificar: ${JSON.stringify(r.body?.error ?? r.body)}`);
    return;
  }
  console.log(`ChatGPT ve: ${describeSeen(r.body?.seen)}`);
  const seen = r.body?.seen as { model?: string; effort?: string; effortPosition?: number; effortSteps?: number } | undefined;
  const ok = /5\.6 Sol/i.test(seen?.model ?? "") && seen?.effortPosition === 3 && seen?.effortSteps === 3;
  console.log(ok
    ? "✓ coincide con lo que anuncia el catalogo (GPT-5.6 Sol · High)"
    : "✗ no es GPT-5.6 Sol · High: Codex con el modelo web fallara cerrado (el chat del panel y `ask` si funcionan). Arreglalo con “Sincronizar a mano”.");
}

async function settingsSync(): Promise<void> {
  if (!(await serverUp())) { console.error("el server esta abajo: isymcp up"); return; }
  const r = await bridgeJson("/isymcp/settings/open", "POST");
  if (r.status !== 202) {
    console.error(`no se abrio: ${String(r.body?.reason ?? r.status)}`);
    return;
  }
  console.log("Se abrio un Chrome visible con tu sesion. Elige GPT-5.6 Sol y reasoning High,");
  console.log("y vuelve aqui. Mientras tanto los turnos esperan en cola.");
  await ask("Enter cuando termines (guarda y cierra la ventana)… ");
  const done = await bridgeJson("/isymcp/settings/finish", "POST");
  const last = done.body?.last as { saved?: boolean; reason?: string } | null | undefined;
  console.log(last ? `${last.saved ? "✓ guardado" : "✗ no guardado"}: ${last.reason ?? ""}` : "ventana cerrada; el resultado aparece en unos segundos (isymcp → Ajustes → Verificar)");
}

// ── Confirmaciones del menu ────────────────────────────────────────────────

async function confirm(question: string): Promise<boolean> {
  return /^(s|si|sí|y|yes)$/i.test(await ask(`${question} [s/N] `));
}

async function harnessInteractive(sub: "install" | "uninstall"): Promise<void> {
  const { detect } = await import("./harness");
  const usable = (await detect()).filter((s) => s.present && s.supported);
  if (usable.length === 0) { console.log("no hay harnesses instalables detectados"); return; }
  console.log(`detectados: ${usable.map((s) => `${s.id}${s.installed === true ? " ✓" : ""}`).join(", ")}`);
  const raw = await ask("¿cuales? (separados por coma, o 'todos'): ");
  if (!raw) return;
  const ids = /^(todos|all)$/i.test(raw) ? ["--all"] : raw.split(/[\s,]+/).filter(Boolean);
  await harnessCommand(sub, ids);
  if (await confirm("¿Ejecutar este plan?")) await harnessCommand(sub, [...ids, "--apply"]);
  else console.log("nada escrito");
}

async function canaryScheduleInteractive(sub: "schedule" | "unschedule"): Promise<void> {
  await canaryCommand(sub, []);
  if (await confirm("¿Aplicar?")) await canaryCommand(sub, ["--apply"]);
  else console.log("nada tocado");
}

function tunnelBin(): string {
  return join(homedir(), ".codex-web-http", "bin", "tunnel-client");
}

function tunnel(action: string): void {
  const bin = tunnelBin();
  if (!existsSync(bin)) {
    console.error(`no esta instalado el tunnel-client. Corre: bun run scripts/install-tunnel.ts`);
    process.exit(1);
  }
  if (action === "connect") {
    const proc = Bun.spawnSync(["bun", "run", join(ROOT, "scripts", "connect-tunnel.ts")], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (proc.exitCode !== 0) console.error(`tunel connect exit ${proc.exitCode}`);
    return;
  }
  if (action === "stop") {
    const proc = sh([bin, "runtimes", "stop", "codex-web-http"]);
    console.log(proc.out.trim() || `exit ${proc.code}`);
    // `runtimes stop` puede decir "Stopped" y dejar vivo el daemon en su sesion
    // tmux (visto 2026-10-06: un daemon de 15.9 h sobrevivio al stop y luego
    // toda llamada devolvia "Session terminated"). Cerrar el tmux a mano.
    const list = sh(["tmux", "list-sessions", "-F", "#{session_name}"]);
    for (const name of list.out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("tunnel-mcp__codex-web-http__"))) {
      const kill = sh(["tmux", "kill-session", "-t", name]);
      if (kill.code === 0) console.log(`tmux ${name} cerrado`);
    }
    return;
  }
  const proc = sh([bin, "runtimes", "status", "codex-web-http", "--json"], 30_000);
  if (proc.code !== 0) {
    console.log(proc.out.trim() || "tunel sin status");
    return;
  }
  try {
    const d = JSON.parse(proc.out) as { ready?: boolean; running?: boolean; runtime_state?: string };
    console.log(`tunel ready=${d.ready ?? "?"} running=${d.running ?? "?"} state=${d.runtime_state ?? "?"}`);
  } catch {
    console.log(proc.out.slice(0, 400));
  }
}

function guardarSesion(name: string): void {
  const source = join(homedir(), ".codex-web-http", "storage-state.json");
  const record = bindCookies(name, source);
  console.log(`sesion ${record.name}: cookies en ${record.statePath}`);
  console.log(`conversacion: ${record.conversationUrl ?? "(aun no hay /c/, el primer turno la guarda)"}`);
}

// session mint|list|revoke — capacidades del MCP nativo (Codex ISyMCP).
// Read-only por defecto; --write habilita apply_patch y escrituras sandbox.
function codexSession(sub: string, rest: string[]): void {
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (sub === "mint") {
    const cwd = opt("--cwd") ?? process.cwd();
    const label = opt("--label");
    const writable = rest.includes("--write") || rest.includes("--writable") || rest.includes("--rw");
    const ttlRaw = opt("--ttl");
    const ttlHours = ttlRaw === undefined ? undefined : Number(ttlRaw);
    const requestFile = opt("--request-file");
    if (rest.includes("--request-file") && (!requestFile || requestFile.startsWith("--")))
      throw new Error("--request-file requiere un archivo de texto dentro del workspace");
    const record = mintSession(cwd, { label, writable, ttlHours, requestFile });
    console.log("sesion Codex ISyMCP creada (el token se muestra UNA vez; el registro es 0600)");
    console.log(`  label:    ${record.label}`);
    console.log(`  cwd:      ${record.cwd}`);
    console.log(`  writable: ${record.writable}`);
    console.log(`  fp:       ${record.fp}`);
    console.log(`  caduca:   ${record.expiresAt ?? "nunca (--ttl 0)"}`);
    if (record.request) console.log(`  request:  ${record.request.filename} [sha256 ${record.request.sha256}]`);
    console.log(`  token:    ${record.token}`);
    console.log("");
    console.log("Para usarla, elegir el app Codex ISyMCP en el composer y pegar:");
    console.log("  COMANDO: @CODEX ISYMCP");
    console.log(`  turn_token: ${record.token}`);
    console.log("  Primero llama codex_turn_start y lee bootstrap.content.");
    console.log(record.request ? "  Ejecuta la tarea local verificada de request.content y devuelve evidencia real." : "  Solicitud: <escribe aquí tu tarea autorizada>.");
    return;
  }
  if (sub === "list") {
    const sessions = listUserSessions();
    for (const s of sessions) {
      const expiry = !s.expiresAt ? "sin-caducidad" : isExpired(s) ? "CADUCADA" : `caduca ${s.expiresAt}`;
      console.log(`${s.createdAt} ${s.writable ? "rw" : "ro"} ${s.cwd} (${s.label}) [${s.fp}] ${expiry}`);
    }
    console.log(`Sessions: ${sessions.length}`);
    return;
  }
  if (sub === "revoke") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) throw new Error("uso: isymcp session revoke <token|fp>");
    console.log(`Revoked sessions: ${revokeSession(target)}`);
    return;
  }
  throw new Error("uso: isymcp session mint --cwd <dir> [--label x] [--write] [--ttl horas] [--request-file TASK.md] | list | revoke <token|fp>");
}

function modelsRestore(): void {
  const result = installWebModels({ restore: true });
  console.log(JSON.stringify(result, null, 2));
}

function installIntoCodex(apply: boolean): void {
  const result = installWebModels({
    apply,
    restore: false,
    url: `${BRIDGE}/v1`,
    caps: process.env.CODEX_WEB_HTTP_CAPS,
    model: apply ? "chatgpt-web/gpt-5.6-sol" : undefined,
    effort: apply ? "high" : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!apply) {
    console.log("(dry-run: no escribio. Modelos → Preparar perfil crea archivos privados de ISyMCP)");
    return;
  }
  console.log("perfil Web preparado: isymcp codex lo activa solo en ese proceso");
  console.log("configuracion y catalogo global de Codex conservados");
}

function command(text: string, effort?: string): void {
  console.log(`# app: ${CONNECTOR_NAME}`);
  console.log(`# token: ${MENTION}\n`);
  console.log("--- INICIO DEL TEXTO A PEGAR ---");
  console.log(buildChatGPTCommand(text, { effort }));
  console.log("--- FIN ---");
}

async function status(): Promise<void> {
  const pid = readPid();
  const up = await serverUp();
  console.log(`isymcp`);
  console.log(`  server   ${up ? "up" : "down"}  http://127.0.0.1:${PORT}  pid=${pid && alive(pid) ? pid : "-"}`);
  console.log(`  log      ${LOG}`);
  tunnel("status");
  // Por nombre de script, no por carpeta: el repo puede vivir en cualquier ruta.
  const mcp = sh(["pgrep", "-af", "src/mcp/main.ts --contract"]);
  const line = mcp.out.split("\n").find((l) => l.includes("mcp/main.ts") && !l.includes("pgrep"));
  console.log(`  mcp      ${line ? "up" : "down"}`);
  console.log(`  connector ${process.env.CODEX_WEB_HTTP_CONNECTOR ?? CONNECTOR_NAME}`);
  try {
    const sessFile = join(homedir(), ".codex-web-http", "sessions", "default.json");
    if (existsSync(sessFile)) {
      const conv = (JSON.parse(readFileSync(sessFile, "utf8")) as { conversationUrl?: string | null }).conversationUrl;
      console.log(`  conversacion ${conv ?? "(sin /c/ aun; el primer turno la guarda)"}`);
    } else {
      console.log("  conversacion (sin sesion de cookies; corre: isymcp session default)");
    }
  } catch {
    console.log("  conversacion (registro de sesion ilegible)");
  }
  const sessions = listUserSessions();
  const detail = sessions.map((s) => `${s.label}[${s.fp}]${s.writable ? "/rw" : "/ro"}`).join(", ");
  console.log(`  sessions  ${sessions.length}${detail ? ` -> ${detail}` : ""}`);
  console.log(`  panel    ${(await panelUp()) ? "up" : "down"}  ${PANEL_URL}`);
  if (up) {
    try {
      const st = await bridgeJson("/isymcp/settings");
      console.log(`  chatgpt  ${describeSeen(st.body?.seen)}`);
    } catch { /* opcional */ }
  }
  try {
    const { readLatestCanary } = await import("./canary");
    const c = readLatestCanary();
    console.log(`  canario  ${c ? `${c.ok ? "OK" : "FALLO"} · ${c.ts}` : "sin correr (isymcp canary)"}`);
  } catch { /* opcional */ }
  try {
    const { listCodexTasks } = await import("./codex-tasks");
    const tasks = listCodexTasks();
    const blocked = tasks.filter((t) => t.state === "bloqueada").length;
    console.log(`  tareas   ${tasks.length} de Codex${blocked ? ` (${blocked} bloqueadas: ver panel)` : ""}`);
  } catch { /* opcional */ }
}

async function menuSession(sub: string, rest: string[]): Promise<void> {
  try {
    codexSession(sub, rest);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
  }
}

function help(): void {
  console.log(`isymcp — consola del bridge Codex ISyMCP

  isymcp                     menu interactivo con todo (en una terminal);
                             sin terminal (pipe/script) imprime el estado
  isymcp status              estado: server, tunel, panel, ChatGPT, canario
  isymcp menu [id]           menu (o una rama/accion: isymcp menu harness)

  isymcp panel               abre el panel :8798 (lo levanta detached si hace falta)
  isymcp panel start|stop|status
  isymcp panel run [--port 8798]   panel en primer plano (Ctrl+C)
  isymcp ask "texto" [--new] turno real con ChatGPT desde la terminal; sigue
                             el mismo chat (visible en el panel); --new abre otro.
                             Tambien por stdin: echo hola | isymcp ask
  isymcp up [--no-connector] levanta server (detached) y conecta el tunel;
                             el server deja elegido el connector Codex ISyMCP
  isymcp down                para server y tunel
  isymcp server start|stop
  isymcp tunnel connect|stop|status
  isymcp models              dry-run del perfil Web privado
  isymcp models apply        prepara perfil aislado; no cambia Codex global
  isymcp models restore      restaura solo el perfil Web propio
  isymcp codex [args...]     ejecuta Codex con perfil ISyMCP aislado (sin mutar config.toml)
  isymcp conversation new [--client cli|app] [--cwd dir] [--model alias]
                             CLI interactivo, proveedor solo de ese proceso.
                             --client app falla: la App no tiene entrada verificada
  isymcp conversation list   hilos confirmados, con id completo
  isymcp conversation resume <launch-id|thread-id>
  isymcp codex launcher      instala lanzador ~/.local/bin/codex-isymcp y .desktop
                             es un CLI en terminal, no la app de Codex
  isymcp command "texto"     texto para pegar en chatgpt.com
  isymcp media prepare      pega una URL, elige carpeta y confirma el paquete
  isymcp media prepare <url> prepara de forma no interactiva y devuelve JSON
  isymcp tui list            TUIs detectadas (config dir y/o binario)
  isymcp tui install         dry-run del parche opencode (provider+MCP)
  isymcp tui install --apply escribe ~/.config/opencode/opencode.json (backup)
  isymcp tui install --restore vuelve al backup
  isymcp session mint --cwd <dir> [--label x] [--write] [--ttl horas] [--request-file TASK.md]
                             crea un session token del MCP (read-only por defecto;
                             caduca a los 7 dias, --ttl 0 = nunca;
                             request-file vincula una tarea local por SHA-256)
  isymcp session list        sesiones vivas (solo fingerprint)
  isymcp session revoke <token|fp>
  isymcp canary              turno real de prueba (eco A, eco B sin A, markdown)
  isymcp canary status       ultimo resultado
  isymcp canary schedule [--apply]   timer diario de systemd (sin --apply: solo muestra)
  isymcp canary unschedule [--apply]
  isymcp harness list        CLIs/TUIs de agentes detectadas + si tienen isymcp-chatgpt
  isymcp harness install <ids|--all> [--apply]
                             instala el MCP isymcp-chatgpt (sin --apply: solo el plan)
  isymcp harness uninstall <ids|--all> [--apply]
  isymcp health              diagnóstico de salud en vivo del bridge y servicios
  isymcp metrics             telemetría en vivo (turnos, tokens, latencias, memoria)
  isymcp metrics --prom      métricas en formato Prometheus / OpenMetrics
  isymcp smoke               batería de pruebas E2E automatizada (health, métricas, harnesses, launcher)
  isymcp logs                ultimos 50
  isymcp logs --last 20
  isymcp logs export         guarda TODOS en ~/.codex-web-http/logs/
  isymcp logs export --since 2026-10-02T16:00 --until 2026-10-02T17:00
  isymcp logs export --out /tmp/isymcp.log

Cerrar esta terminal no mata nada: server y panel quedan detached.
`);
}

function flag(name: string, args: string[]): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function logs(args: string[]): void {
  const since = flag("--since", args);
  const until = flag("--until", args);
  const out = flag("--out", args);
  const lastRaw = flag("--last", args);
  const exporting = args[0] === "export" || args.includes("--all");
  const sinceMs = since ? parseBound(since) : undefined;
  const untilMs = until ? parseBound(until) : undefined;
  const last = exporting ? undefined : Number(lastRaw ?? "50");
  if (last !== undefined && (!Number.isInteger(last) || last < 0)) {
    throw new Error(`--last invalido: ${lastRaw}`);
  }
  const selected = selectLines(readAll(), { last, sinceMs, untilMs });
  if (!exporting) {
    if (selected.length === 0) {
      console.log("sin lineas (el server aun no escribio log, o el filtro no matchea)");
      return;
    }
    for (const line of selected) console.log(formatLine(line));
    console.log(`--- ${selected.length} lineas ---`);
    return;
  }
  const path = out ?? defaultExportPath();
  const saved = exportLines(selected, path);
  console.log(`guardado: ${saved.path}`);
  console.log(`lineas: ${saved.count}`);
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

// Una entrada por hoja visible del menu (tests/menu.test.ts lo exige).
const ACTIONS: Record<string, () => Promise<void> | void> = {
  "up": async () => {
    startServer();
    await new Promise((r) => setTimeout(r, 800));
    console.log(`health: ${(await serverUp()) ? "ok" : "aun no responde"}`);
    tunnel("connect");
    guardarSesion("default");
  },
  "down": () => { tunnel("stop"); stopServer(); },
  "restart": () => { tunnel("stop"); stopServer(); startServer(); tunnel("connect"); },
  "status": () => status(),
  "panel-open": () => openPanel(),
  "panel-start": async () => { await startPanelDetached(); },
  "panel-stop": () => stopPanel(),
  "ask": async () => {
    const text = await ask("pregunta (vacio = cancelar): ");
    if (!text) return;
    const fresh = existsSync(CLI_CHAT) ? !(await confirm("¿Seguir en el mismo chat de la terminal?")) : true;
    await askChatGPT(text, fresh);
  },
  "command": async () => {
    const text = await ask("texto de la tarea: ");
    const effort = await ask("effort [high]: ") || "high";
    if (text) command(text, effort);
  },
  "media-prepare": async () => {
    const { mediaCommand } = await import("./media/cli");
    await mediaCommand("prepare", []);
  },
  "conversation-new": async () => {
    const client = (await ask("cliente [cli/app]: ")) || "cli";
    const cwd = (await ask(`workspace (${process.cwd()}): `)) || process.cwd();
    const model = (await ask("modelo [chatgpt-web/gpt-5.6-sol]: ")) || "chatgpt-web/gpt-5.6-sol";
    await conversationCommand("new", ["--client", client, "--cwd", cwd, "--model", model]);
  },
  "settings-verify": () => settingsVerify(),
  "settings-sync": () => settingsSync(),
  "harness-list": () => harnessCommand("list", []),
  "harness-install": () => harnessInteractive("install"),
  "harness-uninstall": () => harnessInteractive("uninstall"),
  "canary-run": () => canaryCommand("run", []),
  "canary-status": () => canaryCommand("status", []),
  "canary-schedule": () => canaryScheduleInteractive("schedule"),
  "canary-unschedule": () => canaryScheduleInteractive("unschedule"),
  "server-start": () => startServer(),
  "server-stop": () => stopServer(),
  "tunnel-connect": () => tunnel("connect"),
  "tunnel-stop": () => tunnel("stop"),
  "tunnel-status": () => tunnel("status"),
  "logs-50": () => logs(["--last", "50"]),
  "logs-20": () => logs(["--last", "20"]),
  "logs-all": () => logs(["export", "--all"]),
  "logs-window": async () => {
    const since = await ask("desde (2026-10-02T16:00): ");
    const until = await ask("hasta (2026-10-02T17:00): ");
    logs(["export", "--since", since, "--until", until]);
  },
  "models-dry": () => installIntoCodex(false),
  "models-apply": () => installIntoCodex(true),
  "models-restore": () => modelsRestore(),
  "session-list": () => menuSession("list", []),
  "session-mint": async () => {
    const cwd = (await ask(`cwd (${process.cwd()}): `)) || process.cwd();
    const label = await ask("label (ej: mi-proyecto): ");
    await menuSession("mint", ["--cwd", cwd, ...(label ? ["--label", label] : [])]);
  },
  "session-mint-write": async () => {
    const cwd = (await ask(`cwd (${process.cwd()}): `)) || process.cwd();
    if (!(await confirm(`ChatGPT podra ESCRIBIR en ${cwd} (sandbox, 7 dias). ¿Seguro?`))) return;
    const label = await ask("label (ej: mi-proyecto): ");
    await menuSession("mint", ["--cwd", cwd, "--write", ...(label ? ["--label", label] : [])]);
  },
  "session-revoke": async () => {
    const target = await ask("token o fingerprint: ");
    if (target) await menuSession("revoke", [target]);
  },
  "session-cookies": () => guardarSesion("default"),
};

async function runAction(id: string): Promise<void> {
  const action = ACTIONS[id];
  if (!action) {
    console.error(`accion sin implementar: ${id}`);
    return;
  }
  await runHook(`before:${id}`);
  await action();
  await runHook(`after:${id}`);
}

async function openMenu(items = visible(MENU), title = "¿Qué hacemos?"): Promise<void> {
  for (;;) {
    const index = await select(title, items);
    if (index < 0) {
      console.log("nos vemos :p");
      return;
    }
    const item = items[index];
    if (!item || item.id === "quit") {
      console.log("nos vemos :p");
      return;
    }
    console.log("");
    if (item.children) {
      await openMenu(visible(item.children), item.label);
      continue;
    }
    try {
      await runAction(item.id);
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log("");
  }
}

const [cmd, sub, ...rest] = process.argv.slice(2);
const effortFlag = rest.includes("--effort") ? rest[rest.indexOf("--effort") + 1] : undefined;

if (!cmd && process.stdin.isTTY && process.stdout.isTTY) {
  console.log("");
  console.log(brandHeader());
  await openMenu();
} else if (!cmd || cmd === "status") {
  await status();
} else if (cmd === "media") {
  await (await import("./media/cli")).mediaCommand(sub, rest);
} else if (cmd === "tree") {
  console.log(brandHeader());
  for (const label of visibleLabels()) console.log(`  ${label}`);
  const leaked = visibleLabels().filter((label) => label.startsWith("hook."));
  if (leaked.length) throw new Error(`hook visible: ${leaked.join(",")}`);
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  help();
} else if (cmd === "up") {
  const noConnector = [sub, ...rest].includes("--no-connector");
  startServer({ connector: noConnector ? null : undefined });
  await new Promise((r) => setTimeout(r, 800));
  console.log(`health: ${(await serverUp()) ? "ok" : "aun no responde"}`);
  tunnel("connect");
} else if (cmd === "down") {
  tunnel("stop");
  stopServer();
} else if (cmd === "server" && sub === "start") {
  startServer({ connector: rest.includes("--no-connector") ? null : undefined });
} else if (cmd === "server" && sub === "stop") {
  stopServer();
} else if (cmd === "tunnel" && sub) {
  tunnel(sub);
} else if (cmd === "codex") {
  await codexCommand(sub, rest);
} else if (cmd === "conversation") {
  await conversationCommand(sub, rest);
} else if (cmd === "models") {
  if (sub === "restore") modelsRestore();
  else if (sub === "apply") installIntoCodex(true);
  else installIntoCodex(false);
} else if (cmd === "command" && sub) {
  command([sub, ...rest.filter((a) => a !== "--effort" && a !== effortFlag)].join(" "), effortFlag);
} else if (cmd === "tui") {
  const baseUrl = process.env.ISYMCP_TUI_BASE_URL?.trim() || "http://127.0.0.1:8791";
  const mcpMain = join(ROOT, "src", "mcp", "main.ts");
  const configPath = flag("--config", rest) ?? join(homedir(), ".config", "opencode", "opencode.json");
  if (!sub || sub === "list") {
    for (const tui of detectTuis(homedir())) {
      console.log(`${tui.present ? "presente " : "ausente  "}${tui.installable ? "[instalable]" : "            "} ${tui.id} (${tui.label}) ${tui.bin ?? tui.configDir}`);
    }
  } else if (sub === "install") {
    const which = flag("--tui", rest) ?? "opencode";
    if (which !== "opencode") {
      console.error(`tui ${which}: solo inventario por ahora (NOT_DEMONSTRATED su formato de config)`);
      process.exit(2);
    }
    const result = installIntoOpencode({
      configPath,
      backupsDir: join(ROOT, "backups", "tui"),
      baseUrl,
      mcpMain,
      dryRun: !rest.includes("--apply"),
      restore: rest.includes("--restore"),
    });
    console.log(`${result.action} ${result.configPath} modelos=${result.models}${result.backupPath ? ` backup=${result.backupPath}` : ""}`);
    if (result.action === "dry-run") console.log("nada escrito (usa --apply para escribir con backup)");
  } else {
    help();
    process.exit(2);
  }
} else if (cmd === "panel") {
  const argsAll = [sub, ...rest].filter((a): a is string => Boolean(a));
  if (sub === "run" || argsAll.includes("--foreground")) {
    // Primer plano (lo usa tambien el modo detached por debajo).
    const port = Number(flag("--port", argsAll) ?? PANEL_PORT);
    startPanel(port);
    console.log(`panel en http://127.0.0.1:${port} (Ctrl+C para cerrar)`);
  } else if (sub === "start") {
    if (!(await startPanelDetached())) process.exitCode = 1;
  } else if (sub === "stop") {
    stopPanel();
  } else if (sub === "status") {
    console.log(`panel ${(await panelUp()) ? "up" : "down"} ${PANEL_URL}`);
  } else if (!sub || sub === "open") {
    await openPanel();
  } else {
    help();
    process.exit(2);
  }
} else if (cmd === "ask") {
  const args = [sub, ...rest].filter((a): a is string => Boolean(a));
  const fresh = args.includes("--new");
  let text = args.filter((a) => a !== "--new").join(" ");
  if (!text && !process.stdin.isTTY) text = await Bun.stdin.text();
  if (!text.trim()) {
    console.error('uso: isymcp ask "texto" [--new]   (o por stdin: echo hola | isymcp ask)');
    process.exit(2);
  }
  if (!(await askChatGPT(text, fresh))) process.exitCode = 1;
} else if (cmd === "menu") {
  console.log(brandHeader());
  if (sub) {
    const item = findItem(sub);
    if (!item) { console.error(`no existe: ${sub}`); process.exit(2); }
    if (item.children) await openMenu(visible(item.children), item.label);
    else await runAction(sub);
  } else await openMenu();
} else if (cmd === "session") {
  if (sub === "mint" || sub === "list" || sub === "revoke") {
    try {
      codexSession(sub, rest);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(2);
    }
  } else {
    guardarSesion(sub || "default");
  }
} else if (cmd === "canary") {
  await canaryCommand(sub ?? "run", rest);
} else if (cmd === "harness") {
  await harnessCommand(sub ?? "list", rest);
} else if (cmd === "metrics") {
  await metricsCommand(sub, rest);
} else if (cmd === "health") {
  await healthCommand(sub, rest);
} else if (cmd === "smoke" || cmd === "e2e") {
  await smokeCommand(sub, rest);
} else if (cmd === "logs") {
  logs([sub, ...rest].filter((part): part is string => Boolean(part)));
} else {
  help();
  process.exit(2);
}

async function smokeCommand(sub?: string, rest: string[] = []): Promise<void> {
  const json = sub === "--json" || rest.includes("--json");
  const { runE2EAll } = await import("../scripts/e2e-all");
  const result = await runE2EAll({ quiet: json });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.ok) process.exit(1);
}

async function metricsCommand(sub?: string, rest: string[] = []): Promise<void> {
  const json = sub === "--json" || rest.includes("--json");
  const prometheus = sub === "--prom" || sub === "--prometheus" || rest.includes("--prom") || rest.includes("--prometheus");
  const port = process.env.CODEX_WEB_HTTP_PORT?.trim() || "8791";
  const { bridgeAuthHeaders } = await import("./local-guard");
  try {
    if (prometheus) {
      const r = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: bridgeAuthHeaders() });
      if (!r.ok) throw new Error(`bridge devolvio HTTP ${r.status}`);
      console.log(await r.text());
      return;
    }
    const r = await fetch(`http://127.0.0.1:${port}/api/metrics`, { headers: bridgeAuthHeaders() });
    if (!r.ok) throw new Error(`bridge devolvio HTTP ${r.status}`);
    const data = await r.json();
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const { getMetrics } = await import("./metrics");
    const m = data as ReturnType<typeof getMetrics>;
    console.log(`ISyMCP Telemetría en Vivo (Uptime: ${m.uptimeSeconds}s)`);
    console.log(`  Turnos:       ${m.turns.total} total (${m.turns.success} ok, ${m.turns.failed} err, ${m.turns.reasoning_turns} con pensamiento)`);
    console.log(`  Latencia:     avg ${m.latency_ms.avg} ms · min ${m.latency_ms.min} ms · max ${m.latency_ms.max} ms`);
    console.log(`  Tokens est.:  ${m.tokens.total_tokens_estimated.toLocaleString()} total (${m.tokens.prompt_tokens_estimated} prompt, ${m.tokens.completion_tokens_estimated} compl, ${m.tokens.reasoning_tokens_estimated} reasoning)`);
    console.log(`  Memoria:      ${(m.memory.rss_bytes / (1024 * 1024)).toFixed(1)} MB RSS · ${(m.memory.heap_used_bytes / (1024 * 1024)).toFixed(1)} MB Heap`);
    if (Object.keys(m.errors_by_type).length > 0) {
      console.log(`  Errores:      ${Object.entries(m.errors_by_type).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  } catch (err) {
    console.error(`Error obteniendo métricas (¿el bridge está encendido en :${port}?): ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function healthCommand(sub?: string, rest: string[] = []): Promise<void> {
  const json = sub === "--json" || rest.includes("--json");
  const port = process.env.CODEX_WEB_HTTP_PORT?.trim() || "8791";
  const { bridgeAuthHeaders } = await import("./local-guard");
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: bridgeAuthHeaders() });
    if (!r.ok) throw new Error(`bridge devolvio HTTP ${r.status}`);
    const data = await r.json() as { status: string; uptime_seconds: number; web_models: string; upstream: string; turns?: { total: number; success: number } };
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(`ISyMCP Estado de Salud: ${data.status.toUpperCase()} ✓`);
    console.log(`  Uptime:       ${data.uptime_seconds}s`);
    console.log(`  Modelos Web:  ${data.web_models}`);
    console.log(`  Upstream:     ${data.upstream}`);
    console.log(`  Turnos:       ${data.turns?.total ?? 0} procesados (${data.turns?.success ?? 0} exitosos)`);
  } catch (err) {
    console.error(`Bridge no disponible en :${port}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// harness list|install|uninstall — MCP isymcp-chatgpt en otras CLIs/TUIs.
// Sin --apply NUNCA escribe: imprime el comando exacto que correria.
async function harnessCommand(sub: string, rest: string[]): Promise<void> {
  const { apply, CATALOG, detect, plan } = await import("./harness");
  const json = rest.includes("--json");
  if (sub === "list") {
    const statuses = await detect();
    if (json) { console.log(JSON.stringify(statuses, null, 2)); return; }
    for (const s of statuses) {
      const state = !s.present ? "no instalado" : !s.supported ? `detectado · ${s.pending}` : s.installed === true ? "isymcp-chatgpt ✓" : s.installed === false ? "sin isymcp-chatgpt" : "estado desconocido";
      console.log(`  ${s.present ? "●" : "·"} ${s.id.padEnd(9)} ${state}`);
    }
    return;
  }
  if (sub !== "install" && sub !== "uninstall") throw new Error("uso: isymcp harness list | install|uninstall <ids|--all> [--apply]");
  const ids = rest.includes("--all")
    ? (await detect()).filter((s) => s.present && s.supported).map((s) => s.id)
    : rest.filter((a) => !a.startsWith("--"));
  if (ids.length === 0) throw new Error(`indica harnesses (${CATALOG.filter((d) => d.strategy).map((d) => d.id).join(", ")}) o --all`);
  if (!rest.includes("--apply")) {
    console.log(`PLAN (${sub}) — no se escribio nada. Repite con --apply para ejecutarlo:`);
    for (const step of await plan(sub, ids)) console.log(`  ${step.id.padEnd(9)} ${step.argv ? step.argv.join(" ") : `(nada) ${step.reason}`}`);
    return;
  }
  const results = await apply(sub, ids, true);
  if (json) { console.log(JSON.stringify(results, null, 2)); return; }
  for (const r of results) {
    const mark = !r.ran ? "–" : r.ok ? "✓" : "✗";
    console.log(`  ${mark} ${r.id.padEnd(9)} ${r.ran ? `verificado=${r.verified}` : ""} ${r.detail}`);
  }
  if (results.some((r) => r.ran && !r.ok)) process.exitCode = 1;
}

// canary run|status|schedule|unschedule — ¿la captura sigue viva contra el
// chatgpt.com de hoy? schedule/unschedule sin --apply solo muestran.
async function canaryCommand(sub: string, rest: string[]): Promise<void> {
  const { notifyFailure, readLatestCanary, runCanary } = await import("./canary");
  const show = (r: NonNullable<ReturnType<typeof readLatestCanary>>) => {
    console.log(`canario ${r.ok ? "OK ✓" : "FALLO ✗"} · ${r.ts} · bridge=${r.bridge}`);
    for (const c of r.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(9)} ${(c.ms / 1000).toFixed(1)} s · ${c.detail}`);
    if (r.notice) {
      console.log(`  Origen: ${r.notice.source} / ${r.notice.component} · ${r.notice.severity} · ${r.notice.event}`);
      console.log(`  ${r.notice.summary}`);
      console.log(`  Evidencia: ${r.notice.evidence_ref}`);
      if (r.notice.action) console.log(`  Accion: ${r.notice.action}`);
    } else if (r.error) console.log(`  error: ${r.error}`);
  };
  if (sub === "run") {
    const result = await runCanary();
    show(result);
    await notifyFailure(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === "status") {
    const r = readLatestCanary();
    if (!r) { console.log("sin resultados todavia: isymcp canary"); return; }
    show(r);
    return;
  }
  if (sub !== "schedule" && sub !== "unschedule") throw new Error("uso: isymcp canary [run|status|schedule|unschedule] [--apply]");
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const launcher = join(process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http"), "bin", "isymcp-canary");
  const service = `[Unit]\nDescription=ISyMCP canario (captura de chatgpt.com)\n\n[Service]\nType=oneshot\nExecStart=${launcher}\n`;
  const timer = `[Unit]\nDescription=ISyMCP canario diario\n\n[Timer]\nOnCalendar=*-*-* 09:00:00\nPersistent=true\nRandomizedDelaySec=10m\n\n[Install]\nWantedBy=timers.target\n`;
  const steps = sub === "schedule"
    ? [`escribir ${launcher} (lanzador sin espacios)`, `escribir ${join(unitDir, "isymcp-canary.service")}`, `escribir ${join(unitDir, "isymcp-canary.timer")} (diario 09:00, Persistent)`, "systemctl --user daemon-reload", "systemctl --user enable --now isymcp-canary.timer"]
    : ["systemctl --user disable --now isymcp-canary.timer", `borrar ${join(unitDir, "isymcp-canary.service")} y .timer`, "systemctl --user daemon-reload"];
  if (!rest.includes("--apply")) {
    console.log(`PLAN (${sub}) — no se toco nada. Repite con --apply:`);
    for (const step of steps) console.log(`  · ${step}`);
    return;
  }
  const { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const sh = (argv: string[]) => { const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${p.stderr.toString().trim()}`); };
  if (sub === "schedule") {
    mkdirSync(join(launcher, ".."), { recursive: true });
    const script = join(import.meta.dir, "isymcp.ts");
    writeFileSync(launcher, `#!/usr/bin/env bash\n# generado por isymcp canary schedule\nexec ${JSON.stringify(process.execPath)} run '${script.replace(/'/g, `'\\''`)}' canary run\n`, { mode: 0o700 });
    chmodSync(launcher, 0o700);
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "isymcp-canary.service"), service);
    writeFileSync(join(unitDir, "isymcp-canary.timer"), timer);
    sh(["systemctl", "--user", "daemon-reload"]);
    sh(["systemctl", "--user", "enable", "--now", "isymcp-canary.timer"]);
    console.log("timer activo: systemctl --user list-timers isymcp-canary.timer");
  } else {
    Bun.spawnSync(["systemctl", "--user", "disable", "--now", "isymcp-canary.timer"]);
    for (const f of ["isymcp-canary.service", "isymcp-canary.timer"]) if (existsSync(join(unitDir, f))) rmSync(join(unitDir, f));
    sh(["systemctl", "--user", "daemon-reload"]);
    console.log("timer quitado");
  }
}

function spawnCodex(args: string[], extraEnv: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("codex", args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
    child.once("error", (error) => { console.error(`no se pudo iniciar Codex: ${error.message}`); resolve(1); });
    child.once("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
  });
}

async function ensureWebBridge(): Promise<void> {
  if (await isBridgeAlive(PORT)) return;
  console.log(`[isymcp] Bridge local apagado en http://127.0.0.1:${PORT}. Iniciando...`);
  startServer();
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isBridgeAlive(PORT)) return;
  }
  throw new Error(`bridge Web no disponible o no autorizado en ${BRIDGE}; no se inicio Codex`);
}

function commandPositionals(args: string[]): string[] {
  const valued = new Set(["--client", "--cwd", "--model"]);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valued.has(arg)) { i += 1; continue; }
    if (!arg.startsWith("--")) out.push(arg);
  }
  return out;
}

async function conversationCommand(sub: string | undefined, rest: string[]): Promise<void> {
  const {
    conversationsDir, findConversation, listConversations, planNewConversation, planResumeConversation, writeLaunchIntent,
  } = await import("./codex-conversation");
  const dir = conversationsDir();
  if (sub === "list") {
    const rows = listConversations(dir);
    if (!rows.length) console.log("sin conversaciones confirmadas");
    for (const row of rows) console.log(`${row.launchId}\t${row.threadId}\t${row.model}\t${row.cwd}\t${row.url}`);
    return;
  }
  if (sub === "new") {
    const client = flag("--client", rest) ?? "cli";
    const cwd = flag("--cwd", rest) ?? process.cwd();
    const model = flag("--model", rest) ?? "chatgpt-web/gpt-5.6-sol";
    const plan = planNewConversation({ client, cwd, model });
    if (!existsSync(cwd)) throw new Error(`web_conversation_cwd_invalid: no existe ${cwd}`);
    writeLaunchIntent(dir, plan.intent);
    await ensureWebBridge();
    const profile = installWebModels({ apply: true, url: `${BRIDGE}/v1`, model, effort: "high", caps: process.env.CODEX_WEB_HTTP_CAPS });
    const code = await spawnCodex(plan.args({ port: PORT, catalogPath: profile.catalogReady ? profile.catalogPath : undefined }), plan.env);
    if (code !== 0) process.exitCode = code;
    return;
  }
  if (sub === "resume") {
    const id = commandPositionals(rest)[0];
    if (!id) throw new Error("uso: isymcp conversation resume <launch-id|thread-id>");
    const receipt = findConversation(dir, id);
    await ensureWebBridge();
    const profile = installWebModels({
      apply: true, url: `${BRIDGE}/v1`, model: receipt.model, effort: receipt.effort, caps: process.env.CODEX_WEB_HTTP_CAPS,
    });
    const args = planResumeConversation(receipt, { port: PORT, catalogPath: profile.catalogReady ? profile.catalogPath : undefined });
    const code = await spawnCodex(args, { ISYMCP_LAUNCH_ID: receipt.launchId });
    if (code !== 0) process.exitCode = code;
    return;
  }
  throw new Error("uso: isymcp conversation new [--client cli|app] [--cwd dir] [--model alias] | list | resume <launch-id|thread-id>");
}

async function codexCommand(sub: string | undefined, rest: string[]): Promise<void> {
  if (sub === "launcher" || sub === "desktop") {
    if (rest.includes("--remove") || rest.includes("remove") || rest.includes("uninstall")) {
      const res = removeDesktopLauncher();
      console.log(`Lanzador removido: bin=${res.removedBin} desktop=${res.removedDesktop}`);
    } else {
      const res = installDesktopLauncher();
      console.log(`Lanzador instalado con éxito:`);
      console.log(`  CLI Wrapper: [32m${res.binPath}[0m`);
      console.log(`  Desktop Entry: [32m${res.desktopPath}[0m`);
      console.log(`Ahora puedes ejecutar 'codex-isymcp' o abrir 'Codex (ISyMCP Web)' desde tu menú.`);
    }
    return;
  }

  const userArgs = [sub, ...rest].filter((p): p is string => Boolean(p));
  let catalogPath: string | undefined;
  if (usesWebBridge(userArgs)) {
    if (!(await isBridgeAlive(PORT))) {
    console.log(`[isymcp] Bridge local apagado en http://127.0.0.1:${PORT}. Iniciando...`);
    startServer();
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isBridgeAlive(PORT)) break;
    }
    }
    if (!(await isBridgeAlive(PORT))) {
      console.error(`bridge Web no disponible o no autorizado en ${BRIDGE}; no se inicio Codex`);
      process.exitCode = 1;
      return;
    }
    const profile = installWebModels({ apply: true, url: `${BRIDGE}/v1` });
    if (profile.catalogReady) catalogPath = profile.catalogPath;
  }
  const fullArgs = buildCodexArgs(userArgs, PORT, catalogPath);
  const code = await new Promise<number>((resolve) => {
    const child = spawn("codex", fullArgs, { stdio: "inherit", env: process.env });
    child.once("error", (error) => { console.error(`no se pudo iniciar Codex: ${error.message}`); resolve(1); });
    child.once("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
  });
  // La invocacion desde el menu vuelve al menu; no termina todo isymcp.
  if (code !== 0) process.exitCode = code;
}
