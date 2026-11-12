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
import { assertExclusiveTunnel, configuredTunnelAlias, tunnelClientPath } from "./tunnel-routing";
import { startPanel } from "./panel";
import { createChat, loadChat } from "./chats";
import { runHook } from "./hooks";
import { installWebModels } from "../scripts/install-web-models";
import { defaultExportPath, exportLines, formatLine, parseBound, readAll, selectLines } from "./logs";
import { MENU, brandHeader, findItem, select, visible, visibleLabels } from "./menu";
import { buildChatGPTCommand, CONNECTOR_NAME, MENTION } from "./mcp/identity";
import { detectTuis, installIntoOpencode, installIntoTui, installIntoAllTuis } from "./tui";
import { bridgeAuthHeaders, bridgeToken } from "./local-guard";
import { processMatches, stopProcessTree } from "./platform/process";
import { sha256Prefixed } from "./crypto";
import { findCodexWindowsCli } from "./platform/codex-windows-sandbox";
import { installTunnelClient, storeRuntimeKey, storeTunnelId, validateRuntimeKey, validateTunnelId } from "../scripts/install-tunnel";
import { nativeBrowserCommand, parseBrowserOption, rejectUnavailableBrowser } from "./visible/native-browser";

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
const MONITOR_PID = join(RUN, "monitor.pid");
const MONITOR_LOG = join(RUN, "monitor.log");
const MONITOR_PORT = process.env.ISYMCP_MONITOR_PORT?.trim() || "8799";
const MONITOR_URL = `http://127.0.0.1:${MONITOR_PORT}`;
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
    stopProcessTree(pid);
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
    // /ready responde sin calcular el estado: preguntar por "/" obligaba al panel a
    // construirlo (segundos en Windows) dentro de los 1500 ms de este sondeo.
    const res = await fetch(`${PANEL_URL}/ready`, { signal: AbortSignal.timeout(1_500) });
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
    stopProcessTree(pid);
    console.log(`panel parado (pid ${pid})`);
  } else {
    console.log("panel no estaba corriendo (o lo levantaste en primer plano: Ctrl+C alli)");
  }
  try { writeFileSync(PANEL_PID, ""); } catch { /* pid file opcional */ }
}

// ── Monitor residente en background (GOAL-002) ─────────────────────────────
// Demonio continuo (`while (!stopped)` / `setInterval`) que NO se cierra aunque
// lleguen tareas o terminen respuestas; corre indefinidamente hasta `isymcp monitor stop`.

async function monitorUp(port = MONITOR_PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startMonitorDetached(port = MONITOR_PORT, inboxOnly = false): Promise<boolean> {
  if (await monitorUp(port)) {
    const existing = readPid(MONITOR_PID);
    console.log(`monitor continuo ya corre en http://127.0.0.1:${port}${existing ? ` (pid ${existing})` : ""}`);
    return true;
  }
  mkdirSync(RUN, { recursive: true });
  const logFd = openSync(MONITOR_LOG, "a");
  const spawnArgs = ["run", join(ROOT, "src", "isymcp.ts"), "monitor", "run", "--port", String(port)];
  if (inboxOnly) spawnArgs.push("--inbox-only");
  const child = spawn("bun", spawnArgs, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ISYMCP_MONITOR_PORT: String(port) },
  });
  child.unref();
  writeFileSync(MONITOR_PID, `${child.pid}\n`);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await monitorUp(port)) {
      console.log(`monitor continuo detached pid=${child.pid} http://127.0.0.1:${port} log=${MONITOR_LOG}`);
      console.log("puedes cerrar esta terminal: el monitor seguira corriendo sin cerrarse hasta que ejecutes: isymcp monitor stop");
      return true;
    }
  }
  console.error(`el monitor no respondio en 5 s; mira ${MONITOR_LOG}`);
  return false;
}

function stopMonitor(): void {
  const pid = readPid(MONITOR_PID);
  if (pid && alive(pid)) {
    stopProcessTree(pid);
    console.log(`monitor continuo parado (pid ${pid})`);
  } else {
    console.log("monitor no estaba corriendo");
  }
  try {
    writeFileSync(MONITOR_PID, "");
  } catch {
    /* pid file opcional */
  }
}

function openInBrowser(url: string): void {
  try {
    const child = spawn(process.platform === "win32" ? "explorer.exe" : "xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => console.log(`abre a mano: ${url}`));
    child.unref();
    console.log(`abriendo ${url}`);
  } catch {
    console.log(`abre a mano: ${url}`);
  }
}

async function openPanel(pathOrHash = ""): Promise<void> {
  if (!(await serverUp())) console.log(`ojo: el server (:${PORT}) esta abajo; el panel abre igual y lo muestra. Levantalo con: isymcp up`);
  if (await startPanelDetached()) {
    let targetUrl = `${PANEL_URL}${pathOrHash}`;
    try {
      const res = await fetch(`${PANEL_URL}/api/ticket`, {
        method: "POST",
        headers: bridgeAuthHeaders({ "content-type": "application/json" }),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as { ticket?: string };
        if (data.ticket) {
          const sep = pathOrHash.includes("?") ? "&" : "?";
          targetUrl = `${PANEL_URL}/${sep}ticket=${data.ticket}${pathOrHash.startsWith("#") ? pathOrHash : ""}`;
        }
      }
    } catch {}
    openInBrowser(targetUrl);
  }
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
      const st = (await (await fetch(`${BRIDGE}/isymcp/chat/status`, { headers: bridgeAuthHeaders(), signal: AbortSignal.timeout(1_500) })).json()) as {
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
      headers: bridgeAuthHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ chat_id: chatId, message }),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; reply?: { text?: string; meta?: { kind?: string; detail?: string } }; chat?: { conversation_url?: string | null }; error?: { type?
        : string; message?: string } }
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
  const headers = method === "POST"
    ? bridgeAuthHeaders({ "content-type": "application/json" })
    : bridgeAuthHeaders();
  const res = await fetch(`${BRIDGE}${path}`, {
    method,
    headers,
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
  console.log(last ? `${last.saved ? "✓ guardado" : "✗ no guardado"}: ${last.reason ?? ""}` :
    "ventana cerrada; el resultado aparece en unos segundos (isymcp → Ajustes → Verificar)");
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
  return tunnelClientPath(bridgeHome());
}

function tunnel(action: string): void {
  const bin = tunnelBin();
  const alias = configuredTunnelAlias(bridgeHome(), process.env.CODEX_WEB_HTTP_TUNNEL_ALIAS);
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
    if (proc.exitCode !== 0) {
      console.error(`tunel connect exit ${proc.exitCode}`);
      process.exitCode = proc.exitCode || 1;
    }
    return;
  }
  if (action === "stop") {
    const inventory = sh([bin, "runtimes", "list", "--json"], 15_000);
    if (inventory.code !== 0) throw new Error("tunnel_inventory_unavailable: refusing to stop");
    assertExclusiveTunnel(JSON.parse(inventory.out), alias);
    const proc = sh([bin, "runtimes", "stop", alias]);
    console.log(proc.out.trim() || `exit ${proc.code}`);
    // `runtimes stop` puede decir "Stopped" y dejar vivo el daemon en su sesion
    // tmux (visto 2026-10-06: un daemon de 15.9 h sobrevivio al stop y luego
    // toda llamada devolvia "Session terminated"). Cerrar el tmux a mano.
    if (process.platform !== "win32") {
      const list = sh(["tmux", "list-sessions", "-F", "#{session_name}"]);
      for (const name of list.out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith(`tunnel-mcp__${alias}__`))) {
        const kill = sh(["tmux", "kill-session", "-t", name]);
        if (kill.code === 0) console.log(`tmux ${name} cerrado`);
      }
    }
    return;
  }
  const proc = sh([bin, "runtimes", "status", alias, "--json"], 30_000);
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
    console.log(record.request ? "  Ejecuta la tarea local verificada de request.content y devuelve evidencia real." :
      "  Solicitud: <escribe aquí tu tarea autorizada>.");
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
  const mcp = processMatches("src/mcp/main.ts --contract");
  console.log(`  mcp      ${mcp ? "up" : "down"}`);
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
  const monPid = readPid(MONITOR_PID);
  console.log(`  monitor  ${(await monitorUp()) ? "up" : "down"}  ${MONITOR_URL}  pid=${monPid && alive(monPid) ? monPid : "-"}`);
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
  console.log(`isymcp v${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version} — consola del bridge Codex ISyMCP

  isymcp                     menu interactivo con todo (en una terminal);
                             sin terminal (pipe/script) imprime el estado
  isymcp status              estado: server, tunel, panel, ChatGPT, canario
  isymcp menu [id]           menu (o una rama/accion: isymcp menu harness)

  isymcp panel               abre el panel :8798 (lo levanta detached si hace falta)
  isymcp panel control-center abre directamente la vista del Control Center
  isymcp ui | control-center interfaz gráfica web: catálogo CLI, monitor, AGY TUI y suites
  isymcp panel start|stop|status
  isymcp panel run [--port 8798]   panel en primer plano (Ctrl+C)
  isymcp monitor start|stop|status monitor residente continuo en background (no se cierra hasta stop)
  isymcp monitor run [--port 8799] monitor continuo en primer plano (Ctrl+C para matar)
  isymcp monitor lease mint --workspace <id> --cwd <dir> [--ttl-seconds 7200] [--auto-grant]
  isymcp monitor lease renew <lease-id> --ttl-seconds <seg>
  isymcp monitor lease revoke <lease-id>
  isymcp monitor approve <task-id>
  isymcp monitor tasks             lista las tareas encoladas y sus respuestas/estados
  isymcp protocol                  imprime el protocolo oficial de coordinacion y bootstrap de agentes
  isymcp exec "<comando>"          ejecuta un comando bash arbitrario con persistencia de cwd
  isymcp github [cmd]              suite de GitHub: tokens con TTL en horas, asistente
                                   wizard interactivo, API REST y GitHub Actions
  isymcp ask "texto" [--new] turno real con ChatGPT desde la terminal; sigue
                             el mismo chat (visible en el panel); --new abre otro.
                             Tambien por stdin: echo hola | isymcp ask
  isymcp up [--no-connector] levanta server (detached) y conecta el tunel;
                             no toca ~/.codex/config.toml. Para enrutarlo ahi:
                             isymcp models apply, o usa isymcp codex
  isymcp down                para server y tunel
  isymcp server start|stop
  isymcp tunnel setup        abre ajustes de OpenAI, guarda ID/API key y conecta
  isymcp tunnel connect|stop|status
  isymcp native-browser status|probe [--json] diagnostico del navegador nativo
  isymcp ask "texto" --browser native seleccion explicita; falla si no esta disponible
  isymcp models              dry-run del perfil Web privado
  isymcp models apply        prepara perfil aislado; no cambia Codex global
  isymcp models restore      restaura solo el perfil Web propio
  isymcp codex [args...]     ejecuta Codex con perfil ISyMCP aislado (sin mutar config.toml)
  isymcp conversation new [--client cli] [--cwd dir] [--model alias]
                             CLI interactivo, proveedor solo de ese proceso.
  isymcp conversation list   hilos confirmados, con id completo
  isymcp conversation resume <launch-id|thread-id>
  isymcp version             imprime la versión instalada
  isymcp codex launcher      instala lanzador ~/.local/bin/codex-isymcp y .desktop
                             es un CLI en terminal, no la app de Codex
  isymcp command "texto"     texto para pegar en chatgpt.com
  isymcp media prepare      pega una URL, elige carpeta y confirma el paquete
  isymcp media prepare <url> prepara de forma no interactiva y devuelve JSON
  isymcp media transcribe <id> transcribe subtítulos y habla con marcas de tiempo
  isymcp media search <id> <q> busca coincidencias temporales exactas en la transcripción
  isymcp media vmm <id>     genera el Video Multimodal Manifest (timeline de keyframes + voz)
  isymcp comfy workflow add <workflow.json> registra un workflow API local de ComfyUI
  isymcp comfy workflow list lista los workflows registrados
  isymcp comfy status         comprueba la instancia local de ComfyUI
  isymcp tablero status      estado del grupo tablero_* (apagado por defecto)
  isymcp tablero init|on|off plantilla / encender / apagar al instante
  isymcp tablero stop        cierra todas las consolas lanzadas desde el Tablero
  isymcp tui list            TUIs detectadas (config dir y/o binario)
  isymcp tui install [--all | <tui>]  dry-run de instalación de MCP en TUIs
  isymcp tui install [--all | <tui>] --apply  escribe configs con backup (gemini, claude, cursor, opencode, etc.)
  isymcp tui install [--all | <tui>] --restore vuelve al backup anterior
  isymcp tui spawn "<prompt>" [--agent id] [--title t] [--mode auto] [--dry-run]  abre consola de agente (agy, claude, opencode, openisy, codex, gemini...)
  isymcp tui agents          agentes lanzables y cómo les llegan las tareas
  isymcp monitor ack <task> --console <con-id> [--summary s]   ACK de consola (no cierra la tarea; token en $ISYMCP_ACK_TOKEN)
  isymcp monitor respond <task> --console <con-id> --progress|--complete|--fail --summary s
  isymcp monitor consoles [--json]  consolas TUI: console_id, PID real de agy, alive, token_fp, estado
  isymcp monitor console-log <con-id|task-id> [--tail N]  log cronológico de una consola
  isymcp monitor wait-next [segundos] [--console id] espera síncronamente la próxima tarea de ChatGPT
  isymcp monitor respond <id> --summary "..." [--wait] confirma recepción/resultado de tarea
  isymcp monitor alert [--title t] [--summary s] [--source src] encola una alerta o webhook reactivo
  isymcp github watch-ci [run_id|pr] [--detach] despierta un proceso hijo para alertar al monitor al concluir el CI
  isymcp exec "<comando>" [--cwd dir] ejecuta comando shell con CWD persistente
  isymcp fuzz [iteraciones]  ejecuta la suite de fuzzing adversarial (configs TUI y MCP Gateway)
  isymcp session mint --cwd <dir> [--label x] [--write] [--ttl horas] [--request-file TASK.md]
                             crea un session token del MCP (read-only por defecto;
                             caduca a las 24 h, --ttl 0 = nunca;
                             request-file vincula una tarea local por SHA-256)
  isymcp session list        sesiones vivas (solo fingerprint)
  isymcp session revoke <token|fp>
  isymcp canary              turno real de prueba (eco A, eco B sin A, markdown)
  isymcp canary status       ultimo resultado
  isymcp canary schedule [--apply]   programacion diaria (systemd / Task Scheduler; sin --apply: solo muestra)
  isymcp canary unschedule [--apply]
  isymcp allow [status]      permisos del operador para lo que ejecuta código (cerrados por defecto)
  isymcp allow shell on|off  shell_exec en el host sin sandbox
  isymcp allow agents on|off abrir consolas de agentes y pegarles tareas desde ChatGPT
                             on caduca a las 12 h; --for 30m|2h|1d (máx 24h) o --forever
  isymcp allow log [--last N] bitácora de las puertas: qué se permitió/denegó, cuándo y por qué
  isymcp harness list [--server chatgpt|gateway|all]  CLIs/TUIs de agentes detectadas + si tienen el MCP
  isymcp harness install <ids|--all> [--server chatgpt|gateway|all] [--apply]
                             chatgpt = isymcp-chatgpt, gateway = isymcp completo (sin --apply: solo el plan)
  isymcp harness uninstall <ids|--all> [--server chatgpt|gateway|all] [--apply]
  isymcp health              diagnóstico de salud en vivo del bridge y servicios
  isymcp doctor              diagnóstico local: binarios, sandbox, disco, último fallo de media
  isymcp doctor --json       el mismo reporte en JSON (códigos de error incluidos)
  isymcp doctor --explain    añade una explicación con un modelo local (opt-in; no ejecuta nada)
  isymcp doctor --fix <id> [--apply]  plan (dry-run) o aplica un remedio whitelisted
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

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askHidden(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("tunnel setup requiere una terminal interactiva para ocultar las credenciales");
  }

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let escapeState: "none" | "start" | "csi" = "none";
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.off("data", onData);
      try { input.setRawMode(false); } catch { /* noop */ }
      process.stdout.write("\x1b[?2004l\n");
      input.pause();
    };
    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (escapeState === "start") {
          escapeState = char === "[" || char === "O" ? "csi" : "none";
          continue;
        }
        if (escapeState === "csi") {
          if (char >= "@" && char <= "~") escapeState = "none";
          continue;
        }
        if (char === "\x1b") { escapeState = "start"; continue; }
        if (char === "\x03") {
          cleanup();
          reject(new Error("hidden_input_cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (char === "\b" || char === "\x7f") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (char >= " ") value += char;
      }
    };

    process.stdout.write(question);
    input.setEncoding("utf8");
    input.on("data", onData);
    try {
      input.setRawMode(true);
      input.resume();
      process.stdout.write("\x1b[?2004h");
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function tunnelSetup(): Promise<void> {
  openInBrowser("https://platform.openai.com/settings/organization/general");
  console.log("Obtén las credenciales de tu organización; lo que pegues aquí no se mostrará.");
  let tunnelId: string;
  let runtimeKey: string;
  try {
    tunnelId = validateTunnelId(await askHidden("Túnel: "));
    runtimeKey = validateRuntimeKey(await askHidden("API key: "));
  } catch (error) {
    if (error instanceof Error && error.message === "hidden_input_cancelled") {
      console.log("configuración cancelada; no se guardó nada");
      return;
    }
    throw error;
  }

  const binary = await installTunnelClient();
  storeRuntimeKey(runtimeKey);
  storeTunnelId(tunnelId);
  console.log(`credenciales guardadas de forma privada; cliente listo: ${binary}`);

  if (!(await serverUp())) {
    startServer();
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await serverUp()) { ready = true; break; }
    }
    if (!ready) throw new Error("bridge_not_ready: credenciales guardadas; revisa isymcp status");
  }

  tunnel("connect");
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
  "doctor": async () => {
    const { runDoctor, formatDoctor } = await import("./doctor");
    const report = runDoctor();
    console.log(formatDoctor(report));
    const { explainReport, defaultExplainRunner } = await import("./doctor-explain");
    const runner = defaultExplainRunner();
    if (runner) {
      const text = await explainReport(report, runner);
      if (text) console.log(`\nexplicacion (modelo local; no se ejecuta nada de lo que proponga)\n  ${text.replace(/\n/g, "\n  ")}`);
    }
    if (!report.ok) process.exitCode = 1;
  },
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
    const client = (await ask("cliente [cli]: ")) || "cli";
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
  "tunnel-setup": () => tunnelSetup(),
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
    if (!(await confirm(`ChatGPT podra ESCRIBIR en ${cwd} (sandbox, 24 h). ¿Seguro?`))) return;
    const label = await ask("label (ej: mi-proyecto): ");
    await menuSession("mint", ["--cwd", cwd, "--write", ...(label ? ["--label", label] : [])]);
  },
  "session-revoke": async () => {
    const target = await ask("token o fingerprint: ");
    if (target) await menuSession("revoke", [target]);
  },
  "session-cookies": () => guardarSesion("default"),
  "github-status": async () => { await (await import("./github/cli")).githubCommand("status"); },
  "github-tokens-wizard": async () => { await (await import("./github/cli")).githubCommand("tokens", ["wizard"]); },
  "github-tokens-list": async () => { await (await import("./github/cli")).githubCommand("tokens", ["list"]); },
  "github-repos": async () => { await (await import("./github/cli")).githubCommand("repos"); },
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
} else if (cmd === "native-browser") {
  process.exitCode = await nativeBrowserCommand(sub, rest);
} else if (cmd === "tablero") {
  process.exitCode = (await import("./tablero/cli")).tableroCommand(sub ?? "status");
} else if (cmd === "media") {
  try { await (await import("./media/cli")).mediaCommand(sub, rest); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    const message = error instanceof Error ? error.message : String(error);
    console.error(code ? `✗ ${code}: ${message}` : `✗ ${message}`);
    process.exitCode = 1;
  }
} else if (cmd === "comfy") {
  try { await (await import("./comfyui/cli")).comfyCommand(sub, rest); }
  catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (cmd === "github") {
  try {
    process.exitCode = await (await import("./github/cli")).githubCommand(sub, rest);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (cmd === "doctor") {
  const { runDoctor, formatDoctor, mediaStateHome } = await import("./doctor");
  const json = sub === "--json" || rest.includes("--json");
  const explain = sub === "--explain" || rest.includes("--explain");
  const report = runDoctor();
  console.log(json ? JSON.stringify(report, null, 2) : formatDoctor(report));
  if (explain) {
    const { explainReport, defaultExplainRunner } = await import("./doctor-explain");
    const runner = defaultExplainRunner();
    if (!runner) {
      console.log("\nexplicacion: sin motor configurado (exporta ISYMCP_EXPLAIN_CMD); los remedios de arriba son deterministas.");
    } else {
      const text = await explainReport(report, runner);
      console.log("\nexplicacion (modelo local; no se ejecuta nada de lo que proponga)");
      console.log(text ? `  ${text.replace(/\n/g, "\n  ")}` : "  sin respuesta del motor; usa los remedios deterministas de arriba.");
    }
  }
  const argv = [sub, ...rest].filter((value): value is string => typeof value === "string");
  const fixAt = argv.indexOf("--fix");
  if (fixAt !== -1) {
    const { applyFix, listFixActions, planFix } = await import("./doctor-fix");
    const action = argv[fixAt + 1] && !argv[fixAt + 1].startsWith("--") ? argv[fixAt + 1] : "";
    if (!action) {
      console.error(`✗ --fix requiere una accion; permitidas: ${listFixActions().join(", ")}`);
      process.exitCode = 1;
    } else if (!argv.includes("--apply")) {
      try {
        console.log(`\nplan --fix ${action}: ${planFix(action)}\n  (dry-run; añade --apply para ejecutarla)`);
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    } else {
      try {
        const result = applyFix(action, { mediaHome: mediaStateHome() });
        console.log(`\n--fix ${action}: ${result.detail}`);
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
  }
  if (!report.ok) process.exitCode = 1;
} else if (cmd === "tree") {
  console.log(brandHeader());
  for (const label of visibleLabels()) console.log(`  ${label}`);
  const leaked = visibleLabels().filter((label) => label.startsWith("hook."));
  if (leaked.length) throw new Error(`hook visible: ${leaked.join(",")}`);
} else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  console.log(`isymcp v${pkg.version ?? "unknown"}`);
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
} else if (cmd === "tunnel" && sub === "setup") {
  await tunnelSetup();
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
  if (sub === "--help" || sub === "-h") {
    console.log(`
isymcp tui — Gestión de integración MCP en entornos de agentes y TUIs

USO:
  isymcp tui list                         Lista las herramientas/TUIs detectadas en el sistema
  isymcp tui install [tui|--all]          Muestra el plan de configuración MCP (dry-run por defecto)
  isymcp tui install [tui|--all] --apply  Aplica los cambios en las configs con respaldo automático
  isymcp tui install [tui|--all] --restore Restaura la configuración previa desde el último backup
  isymcp tui spawn "<instrucción>" [--agent <id>] [--dry-run]  Abre una consola de agente (agy por defecto)
  isymcp tui agents                       Agentes que se pueden lanzar y cómo reciben tareas

EJEMPLOS:
  isymcp tui install openisy --apply      # Configura OpenCode / OpenISy
  isymcp tui install agy --apply          # Configura Antigravity CLI / Gemini
  isymcp tui install claude --apply       # Configura Claude Desktop / Code
  isymcp tui install --all --apply        # Aplica en todas las TUIs presentes en el host
  isymcp tui spawn "Hola agy"             # Lanza consola visible de Antigravity
  isymcp tui spawn "Revisa PITON" --agent openisy   # Misma coordinación con OpenISy
`);
    process.exit(0);
  }
  const baseUrl = process.env.ISYMCP_TUI_BASE_URL?.trim() || "http://127.0.0.1:8791";
  const configPath = flag("--config", rest) ?? join(homedir(), ".config", "opencode", "opencode.json");
  if (!sub || sub === "list") {
    for (const tui of detectTuis(homedir())) {
      console.log(`${tui.present ? "presente " : "ausente  "}${tui.installable ? "[instalable]" : "            "} ${tui.id} (${tui.label}) ${
        tui.bin ?? tui.configDir}`);
    }
  } else if (sub === "install") {
    const targetConfigPath = flag("--config", rest);
    const positional: string[] = [];
    const flagsWithValues = new Set(["--config", "--tui", "--base-url", "--mcp-main"]);
    for (let i = 0; i < rest.length; i++) {
      if (flagsWithValues.has(rest[i])) {
        i++; // saltar el valor asociado
        continue;
      }
      if (!rest[i].startsWith("-")) {
        positional.push(rest[i]);
      }
    }

    const isAll = rest.includes("--all") || flag("--tui", rest) === "all" || positional.includes("all");
    const which = flag("--tui", rest) ?? (positional[0] ? positional[0] : (isAll ? "all" : (targetConfigPath ? "opencode" : "all")));
    const dryRun = !rest.includes("--apply");
    const restore = rest.includes("--restore");
    const backupsDir = join(ROOT, "backups", "tui");

    if (isAll || which === "all") {
      const results = installIntoAllTuis({
        backupsDir,
        baseUrl,
        dryRun,
        restore,
        onlyPresent: !rest.includes("--force-all"),
      });
      let hasErrors = false;
      const viaHarness: string[] = [];
      for (const { tui, result, error } of results) {
        if (error) {
          hasErrors = true;
          console.error(`✗ ${tui.id} (${tui.label}): ${error}`);
        } else if (result) {
          // Provider de modelos Web (solo opencode/openisy); el MCP de todas va por harness.
          if (result.models > 0 || result.action === "restore") {
            console.log(`${result.action === "dry-run" ? "[dry-run]" : "✓"} ${tui.id} (${tui.label}): provider ${result.configPath} modelos=${result.models} ${result.backupPath ? `(backup: ${result.backupPath})` : ""}`);
          }
          if (result.harness) viaHarness.push(tui.id);
        }
      }
      if (viaHarness.length > 0 && !restore) {
        console.log(`\nMCP (gateway isymcp) por harness: ${viaHarness.join(", ")}`);
        await harnessCommand("install", [...viaHarness, "--server", "gateway", ...(dryRun ? [] : ["--apply"])]);
      }
      if (hasErrors) process.exitCode = 1;
      if (dryRun) console.log("\nModo dry-run: ningún archivo modificado. Usa '--apply' para escribir los cambios con backup.");
    } else {
      try {
        const result = installIntoTui({
          tuiId: which,
          configPath: targetConfigPath,
          backupsDir,
          baseUrl,
          dryRun,
          restore,
        });
        const { findAgent } = await import("./agents/catalog");
        const id = findAgent(which)?.id ?? which;
        const providerTouched = result.models > 0 || result.action === "restore";
        if (providerTouched) {
          console.log(`${result.action === "dry-run" ? "[dry-run]" : "✓"} ${id}: provider ${result.configPath} modelos=${result.models}${result.backupPath ? ` backup=${result.backupPath}` : ""}`);
        }
        if (result.harness && restore && !providerTouched) {
          throw new Error(`el MCP de ${id} lo instala harness: usa isymcp harness uninstall ${id} --server gateway --apply`);
        }
        if (result.harness && !restore) {
          console.log(`MCP (gateway isymcp) por harness:`);
          await harnessCommand("install", [id, "--server", "gateway", ...(dryRun ? [] : ["--apply"])]);
        }
        if (dryRun) console.log("nada escrito (usa --apply para escribir)");
      } catch (err: any) {
        console.error(`Error instalando en ${which}: ${err.message}`);
        process.exitCode = 1;
      }
    }
  } else if (sub === "agents") {
    const { AGENT_TUIS, findAgentBinary } = await import("./agent-tuis");
    const rows = AGENT_TUIS.map((a) => ({ agent: a.id, label: a.label, bin: findAgentBinary(a), prompt_via: a.promptVia, listener: a.listener }));
    if (rest.includes("--json")) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) {
      console.log(`  ${r.bin ? "●" : "·"} ${r.agent.padEnd(9)} ${r.bin ? r.bin : "no instalado"}  · prompt ${r.prompt_via} · tareas ${r.listener}`);
    }
  } else if (sub === "spawn") {
    const flagsWithVal = new Set(["--cwd", "--title", "--mode", "--terminal", "--agent"]);
    const positionals: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (flagsWithVal.has(rest[i])) {
        i++;
        continue;
      }
      if (!rest[i].startsWith("-")) positionals.push(rest[i]);
    }
    const agent = flag("--agent", rest) || "agy";
    const prompt = positionals.join(" ") || `Hola ${agent}`;
    const cwd = flag("--cwd", rest);
    const title = flag("--title", rest);
    const mode = (flag("--mode", rest) as any) || "auto";
    const terminalPreference = flag("--terminal", rest) as any;
    const dryRun = rest.includes("--dry-run");
    const { spawnAgentTui } = await import("./tui-launcher");
    const res = await spawnAgentTui({ agent, prompt, cwd, title, mode, terminalPreference, dryRun });
    if (dryRun) console.log(JSON.stringify({ ...res, command: res.command.map((a) => (a.length > 160 ? `${a.slice(0, 157)}...` : a)) }, null, 2));
    console.log(res.ok ? `✓ ${res.message}` : `✗ Error: ${res.error || res.message}`);
    process.exitCode = res.ok ? 0 : 1;
  } else {
    help();
    process.exit(2);
  }
} else if (cmd === "ui" || cmd === "control-center" || (cmd === "panel" && (sub === "control-center" || sub === "ui"))) {
  await openPanel("#control-center");
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
  let selected: ReturnType<typeof parseBrowserOption>;
  try { selected = parseBrowserOption([sub, ...rest].filter((a): a is string => Boolean(a))); }
  catch (error) { console.error(error instanceof Error ? error.message : "browser_selection_invalid"); process.exit(2); }
  const denied = rejectUnavailableBrowser(selected.browser);
  if (denied) {
    const body = await denied.json();
    console.error(`${body.error.type}: ${body.error.message}`);
    process.exit(2);
  }
  const args = selected.args;
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
} else if (cmd === "allow") {
  // Permisos del operador (src/permissions.ts). Se leen en cada llamada: no hace falta reiniciar nada.
  const P = await import("./permissions");
  const alias: Record<string, "host_shell" | "agent_spawn"> = { shell: "host_shell", host_shell: "host_shell", agents: "agent_spawn", agent_spawn: "agent_spawn", consoles: "agent_spawn" };
  const left = (iso: string) => {
    const total = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
    const h = Math.floor(total / 60), m = total % 60;
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
  };
  const show = () => {
    for (const cap of P.CAPABILITIES) {
      const src = P.permissionSource(cap);
      const fg = P.fileGrant(cap);
      const label = cap === "host_shell" ? "shell  " : "agents ";
      const what = cap === "host_shell" ? "shell_exec en el host (sin sandbox)" : "abrir consolas de agentes y pegarles tareas";
      const by = src === "env" ? `por ${P.capabilityEnvVar(cap)}` : src === "file" ? (fg.until ? `caduca en ${left(fg.until)} (${new Date(fg.until).toLocaleTimeString()})` : "sin caducidad (--forever)") : src ? "por OperatorGrant" : fg.expired ? "caducó" : "";
      console.log(`  ${src ? "● ENCENDIDO" : "○ apagado  "} ${label} ${what}${by ? ` · ${by}` : ""}`);
    }
  };
  if (!sub || sub === "status") {
    show();
  } else if (sub === "log") {
    const n = Number(flag("--last", rest) ?? "20");
    const rows = P.readAudit(Number.isFinite(n) ? n : 20);
    if (rest.includes("--json")) console.log(JSON.stringify(rows, null, 2));
    else if (rows.length === 0) console.log(`  (bitácora vacía: ${P.auditLogPath()})`);
    else for (const r of rows) {
      const extra = ["agent", "console_id", "task_id", "command"].filter((k) => r[k] !== undefined).map((k) => `${k}=${String(r[k])}`).join(" ");
      const mark = r.decision === "allow" ? "✓" : r.decision === "deny" ? "✗" : "•";
      const cap = r.cap === "host_shell" ? "shell " : "agents";
      console.log(`  ${String(r.ts).slice(0, 19).replace("T", " ")}  ${mark} ${cap} ${String(r.action).padEnd(24)} ${r.source ?? (r.reason ?? "-")}${r.ttl ? ` ${r.ttl}` : ""}  ${extra}`.slice(0, 220));
    }
  } else {
    const cap = alias[sub];
    const state = rest[0];
    const usage = (msg: string): never => {
      console.error(`✗ ${msg}`);
      process.exit(2);
    };
    if (!cap || (state !== "on" && state !== "off")) {
      usage("uso: isymcp allow [status|log] | isymcp allow shell|agents on [--for 2h|--forever] | isymcp allow shell|agents off");
    }
    let ttl: number | null | undefined;
    if (state === "on") {
      const forRaw = flag("--for", rest);
      if (rest.includes("--forever")) ttl = null;
      else if (forRaw !== undefined) {
        const ms = P.parseDuration(forRaw);
        if (ms === null) usage(`--for no se entiende: '${forRaw}' (usa 30m, 2h, 1d)`);
        if (ms! > P.MAX_TTL_MS) usage("--for máximo 24h; para dejarlo sin caducidad usa --forever a propósito");
        ttl = ms;
      }
    }
    P.setPermission(cap, state === "on", process.env, ttl);
    P.appendAudit({ cap, action: `allow ${state}`, decision: "operator", source: "cli", ...(ttl !== undefined ? { ttl: ttl === null ? "forever" : `${Math.round(ttl / 60_000)}m` } : {}) });
    show();
    if (state === "off" && process.env[P.capabilityEnvVar(cap)] === "1") {
      console.log(`  ojo: ${P.capabilityEnvVar(cap)}=1 en el entorno lo sigue encendiendo`);
    }
  }
} else if (cmd === "harness") {
  await harnessCommand(sub ?? "list", rest);
} else if (cmd === "metrics") {
  await metricsCommand(sub, rest);
} else if (cmd === "health") {
  await healthCommand(sub, rest);
} else if (cmd === "smoke" || cmd === "e2e") {
  await smokeCommand(sub, rest);
} else if (cmd === "monitor") {
  await monitorCommand(sub, rest);
} else if (cmd === "protocol" || cmd === "agents") {
  const { ISYMCP_AGENT_PROTOCOL_MD } = await import("./agent-protocol");
  console.log(ISYMCP_AGENT_PROTOCOL_MD);
} else if (cmd === "exec" || cmd === "sh") {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`
isymcp exec — Ejecución directa de comandos en shell local con CWD persistente

USO:
  isymcp exec "<comando>" [--cwd <directorio>] [--timeout <ms>]

EJEMPLOS:
  isymcp exec "git status"
  isymcp exec "cd ~/Development && ls"
`);
    process.exit(0);
  }
  const { executeShellCommand } = await import("./shell/executor");
  const targetCwd = flag("--cwd", rest);
  const timeoutMs = flag("--timeout", rest) ? Number(flag("--timeout", rest)) : undefined;
  const filtered = [sub, ...rest].filter((a, idx, arr) => {
    if (a === "--cwd" || a === "--timeout") return false;
    if (idx > 0 && (arr[idx - 1] === "--cwd" || arr[idx - 1] === "--timeout")) return false;
    return Boolean(a);
  });
  const fullCmd = filtered.join(" ");
  if (!fullCmd) {
    console.error('uso: isymcp exec "<comando>"');
    process.exit(1);
  }
  const res = await executeShellCommand({ command: fullCmd, cwd: targetCwd, timeoutMs });
  if (res.stdout) process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : `${res.stdout}\n`);
  if (res.stderr) process.stderr.write(res.stderr.endsWith("\n") ? res.stderr : `${res.stderr}\n`);
  process.exitCode = res.exit_code;
} else if (cmd === "fuzz") {
  if (sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(`
isymcp fuzz — Suite de pruebas de robustez y fuzzing adversarial

USO:
  isymcp fuzz [iteraciones]

DESCRIPCIÓN:
  Ejecuta pruebas sintácticas intensivas sobre el instalador de TUIs
  y el Universal Gateway de ISyMCP para certificar robustez ante entradas adversariales.

EJEMPLO:
  isymcp fuzz 50   # Ejecuta 50 iteraciones por suite (por defecto: 50)
`);
    process.exit(0);
  }
  const { runFullFuzzSuite } = await import("./fuzzer");
  const itArg = [sub, ...rest].find((a) => a && !a.startsWith("--"));
  const iterations = itArg ? parseInt(itArg, 10) : 50;
  console.log(`Ejecutando suite de fuzzing ISyMCP (${isNaN(iterations) ? 50 : iterations} iteraciones por suite)...`);
  const report = await runFullFuzzSuite(isNaN(iterations) ? 50 : iterations);
  for (const r of report.reports) {
    const tag = r.crashes === 0 && r.failed === 0 ? "✓" : "✗";
    console.log(`${tag} ${r.name}: ${r.passed}/${r.iterations} pasaron, ${r.failed} fallaron, ${r.crashes} crashes (${r.duration_ms}ms)`);
    for (const a of r.anomalies) {
      console.log(`    ⚠ ${a}`);
    }
  }
  console.log(`\nResultado global: ${report.ok ? "PASS (cero crashes)" : "FAIL"} [${report.duration_ms}ms]`);
  if (!report.ok) process.exitCode = 1;
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
    console.log(`  Tokens est.:  ${m.tokens.total_tokens_estimated.toLocaleString()} total (${m.tokens.prompt_tokens_estimated} prompt, ${
      m.tokens.completion_tokens_estimated} compl, ${m.tokens.reasoning_tokens_estimated} reasoning)`);
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

// harness list|install|uninstall — MCP de ISyMCP en otras CLIs/TUIs.
//   --server chatgpt (defecto): isymcp-chatgpt (chatgpt_ask)
//   --server gateway: isymcp (gateway completo: tool isymcp, monitor, consolas, media, github)
//   --server all: ambos
// Sin --apply NUNCA escribe: imprime el comando exacto que correria.
async function harnessCommand(sub: string, rest: string[]): Promise<void> {
  const { apply, CATALOG, detect, plan, serverName } = await import("./harness");
  const json = rest.includes("--json");
  const serverArg = (() => {
    const i = rest.indexOf("--server");
    const v = i >= 0 ? rest[i + 1] : rest.find((a) => a.startsWith("--server="))?.slice(9);
    return (v ?? "chatgpt").toLowerCase();
  })();
  if (!["chatgpt", "gateway", "all"].includes(serverArg)) throw new Error("--server debe ser chatgpt, gateway o all");
  const kinds = (serverArg === "all" ? ["chatgpt", "gateway"] : [serverArg]) as Array<"chatgpt" | "gateway">;
  const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--server");
  if (sub === "list") {
    const byKind = await Promise.all(kinds.map((k) => detect(undefined, k)));
    if (json) { console.log(JSON.stringify(Object.fromEntries(kinds.map((k, i) => [k, byKind[i]])), null, 2)); return; }
    const first = byKind[0]!;
    for (let r = 0; r < first.length; r++) {
      const s = first[r]!;
      const cols = kinds.map((k, i) => {
        const x = byKind[i]![r]!;
        const n = serverName(k);
        return !x.present ? "" : !x.supported ? `detectado · ${x.pending}` : x.installed === true ? `${n} ✓` : x.installed === false ? `sin ${n}` : `${n}: estado desconocido`;
      });
      console.log(`  ${s.present ? "●" : "·"} ${s.id.padEnd(9)} ${s.present ? cols.join("  ·  ") : "no instalado"}`);
    }
    return;
  }
  if (sub !== "install" && sub !== "uninstall") throw new Error("uso: isymcp harness list | install|uninstall <ids|--all> [--server chatgpt|gateway|all] [--apply]");
  for (const kind of kinds) {
    const ids = rest.includes("--all")
      ? (await detect(undefined, kind)).filter((s) => s.present && s.supported).map((s) => s.id)
      : positional;
    if (ids.length === 0) throw new Error(`indica harnesses (${CATALOG.filter((d) => d.strategy).map((d) => d.id).join(", ")}) o --all`);
    if (kinds.length > 1) console.log(`── ${serverName(kind)} ──`);
    if (!rest.includes("--apply")) {
      console.log(`PLAN (${sub} ${serverName(kind)}) — no se escribio nada. Repite con --apply para ejecutarlo:`);
      for (const step of await plan(sub, ids, kind)) console.log(`  ${step.id.padEnd(9)} ${step.argv ? step.argv.join(" ") : `(nada) ${step.reason}`}`);
      continue;
    }
    const results = await apply(sub, ids, true, kind);
    if (json) { console.log(JSON.stringify(results, null, 2)); continue; }
    for (const r of results) {
      const mark = !r.ran ? "–" : r.ok ? "✓" : "✗";
      console.log(`  ${mark} ${r.id.padEnd(9)} ${r.ran ? `verificado=${r.verified}` : ""} ${r.detail}`);
    }
    if (results.some((r) => r.ran && !r.ok)) process.exitCode = 1;
  }
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
  const home = process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http");
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const launcher = join(home, "bin", process.platform === "win32" ? "isymcp-canary.ps1" : "isymcp-canary");
  const service = `[Unit]\nDescription=ISyMCP canario (captura de chatgpt.com)\n\n[Service]\nType=oneshot\nExecStart=${launcher}\n`;
  const timer =
    (`[Unit]\nDescription=ISyMCP canario diario\n\n[Timer]\nOnCalendar=*-*-* 09:00:00\nPersistent=true\nRandomizedDelaySec=10m\n\n[Install]\nWantedBy=timers.` +
      `target\n`);
  const windows = process.platform === "win32";
  const steps = windows
    ? sub === "schedule"
      ? [`escribir ${launcher} con ACL privada`, `crear tarea diaria de Windows a las 09:00 (solo cuando el usuario inicio sesion)`]
      : [`eliminar tarea de Windows "ISyMCP Canary"`, `borrar ${launcher}`]
    : sub === "schedule"
      ? [`escribir ${launcher} (lanzador sin espacios)`, `escribir ${join(unitDir, "isymcp-canary.service")}`, `escribir ${join(unitDir,
        "isymcp-canary.timer")} (diario 09:00, Persistent)`, "systemctl --user daemon-reload", "systemctl --user enable --now isymcp-canary.timer"]
      : ["systemctl --user disable --now isymcp-canary.timer", `borrar ${join(unitDir, "isymcp-canary.service")} y .timer`, "systemctl --user daemon-reload"];
  if (!rest.includes("--apply")) {
    console.log(`PLAN (${sub}) — no se toco nada. Repite con --apply:`);
    for (const step of steps) console.log(`  · ${step}`);
    return;
  }
  if (windows) {
    const { installWindowsCanaryTask, removeWindowsCanaryTask } = await import("./platform/canary-scheduler");
    if (sub === "schedule") installWindowsCanaryTask({ home, bunPath: process.execPath, entryPath: join(import.meta.dir, "isymcp.ts") });
    else removeWindowsCanaryTask(home);
    console.log(sub === "schedule" ? "tarea activa: Windows Task Scheduler · diario 09:00 · usuario conectado" : "tarea quitada");
    return;
  }
  const { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const sh = (argv: string[]) => { const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(`${
    argv.join(" ")}: ${p.stderr.toString().trim()}`); };
  if (sub === "schedule") {
    mkdirSync(join(launcher, ".."), { recursive: true });
    const script = join(import.meta.dir, "isymcp.ts");
    writeFileSync(launcher, `#!/usr/bin/env bash\n# generado por isymcp canary schedule\nexec ${JSON.stringify(process.execPath)} run '${script.replace(/'/g,
      `'\\''`)}' canary run\n`, { mode: 0o700 });
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
    const env = { ...process.env, ...extraEnv };
    const executable = process.platform === "win32" ? findCodexWindowsCli(env) : "codex";
    if (!executable) {
      console.error("no se pudo iniciar Codex: falta codex.exe; instala @openai/codex o define ISYMCP_CODEX_CLI_BIN");
      resolve(1);
      return;
    }
    const child = spawn(executable, args, { stdio: "inherit", env });
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
    if (client !== "cli") throw new Error("web_conversation_client_unsupported: isolated Desktop App profiles are UNKNOWN / NO EXECUTE; use --client cli");
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
    if (receipt.client !== "cli") throw new Error("web_conversation_resume_invalid: only a committed CLI receipt can resume");
    await ensureWebBridge();
    const profile = installWebModels({
      apply: true, url: `${BRIDGE}/v1`, model: receipt.model, effort: receipt.effort, caps: process.env.CODEX_WEB_HTTP_CAPS,
    });
    const args = planResumeConversation(receipt, { port: PORT, catalogPath: profile.catalogReady ? profile.catalogPath : undefined });
    const code = await spawnCodex(args, { ISYMCP_LAUNCH_ID: receipt.launchId });
    if (code !== 0) process.exitCode = code;
    return;
  }
  throw new Error("uso: isymcp conversation new [--client cli] [--cwd dir] [--model alias] | list | resume <launch-id|thread-id>");
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
  // El perfil aislado manda x-isymcp-token desde CODEX_WEB_HTTP_TOKEN.
  const code = await spawnCodex(fullArgs, usesWebBridge(userArgs) ? { CODEX_WEB_HTTP_TOKEN: bridgeToken() } : {});
  // La invocacion desde el menu vuelve al menu; no termina todo isymcp.
  if (code !== 0) process.exitCode = code;
}

async function monitorCommand(sub: string | undefined, rest: string[]): Promise<void> {
  const { openBridgeMonitorStack } = await import("./remote-monitor");
  const argsAll = [sub, ...rest].filter((a): a is string => Boolean(a));
  const port = Number(flag("--port", argsAll) ?? MONITOR_PORT);
  const ownerId = flag("--owner", argsAll) ?? (process.env.USER || "owner");

  if (!sub || sub === "status") {
    const up = await monitorUp(String(port));
    const pid = readPid(MONITOR_PID);
    const { db, monitor } = openBridgeMonitorStack();
    try {
      const tasks = monitor.listTasks(20);
      const activeLeases = db
        .query("SELECT lease_id, workspace_id, scopes_json, expires_at, absolute_deadline FROM leases WHERE revoked_at IS NULL AND expires_at > ?")
        .all(Date.now()) as any[];
      console.log(`monitor continuo: ${up ? "UP ✓ (corriendo sin cerrarse)" : "DOWN"} · http://127.0.0.1:${port} · pid=${pid && alive(pid) ? pid : "-"}`);
      console.log(`  leases activos: ${activeLeases.length}`);
      for (const l of activeLeases) {
        const minsLeft = Math.max(0, Math.round((Number(l.expires_at) - Date.now()) / 60_000));
        console.log(`    · ${l.lease_id} · ws=${l.workspace_id} · expira en ${minsLeft} min (${new Date(Number(l.expires_at)).toISOString()})`);
      }
      console.log(`  tareas recientes: ${tasks.length}`);
      for (const t of tasks.slice(0, 10)) {
        console.log(`    · ${t.task_id} [${t.state}] ws=${t.workspace_id} kind=${t.kind} attempts=${t.attempt_count} — ${t.description.slice(0, 60)}`);
      }
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "start") {
    const inboxOnly = argsAll.includes("--inbox-only");
    if (!(await startMonitorDetached(String(port), inboxOnly))) process.exitCode = 1;
    return;
  }

  if (sub === "stop") {
    stopMonitor();
    return;
  }

  if (sub === "run") {
    const intervalMs = Number(flag("--interval-ms", argsAll) ?? "500");
    const inboxOnly = argsAll.includes("--inbox-only");
    const { db, monitor, transport } = openBridgeMonitorStack();
    const server = transport.startLoopbackServer(port);
    const loop = inboxOnly
      ? null
      : monitor.startContinuousLoop({
          pollIntervalMs: intervalMs,
          onTaskCompleted: (task) => {
            console.log(
              `[${new Date().toISOString()}] [monitor] tarea procesada ${task.task_id} -> state=${task.state} (sigue esperando nuevas tareas...)`,
            );
          },
        });
    console.log(
      `[${new Date().toISOString()}] [monitor] demonio continuo activo en http://127.0.0.1:${server.port} (pid=${process.pid}, mode=${inboxOnly ? "inbox-only-wakeup" : `auto-worker:${intervalMs}ms`}). NO se cerrará hasta recibir SIGINT/SIGTERM o 'isymcp monitor stop'.`,
    );

    await new Promise<void>((resolve) => {
      const shutdown = (sig: string) => {
        console.log(`[${new Date().toISOString()}] [monitor] recibida señal ${sig}; deteniendo bucle continuo...`);
        loop?.stop();
        server.stop(true);
        db.close();
        resolve();
      };
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
    });
    return;
  }

  const consoleFlag = flag("--console", argsAll);
  const waitNextUnackedTask = async (timeoutSec: number) => {
    const deadline = Date.now() + timeoutSec * 1000;
    console.error(`[monitor:wait-next] Escuchando nuevas tareas de ChatGPT por hasta ${timeoutSec}s para despertar a Argon...`);
    while (Date.now() < deadline) {
      const { db, monitor } = openBridgeMonitorStack();
      try {
        const tasks = monitor.listTasks(20);
        const unacked = tasks.find((t) => {
          // Aislamiento por consola: --console X solo ve tareas dirigidas a X; sin --console se ignoran las dirigidas.
          const targeted = t.conversation_ref.startsWith("console:");
          if (consoleFlag) { if (t.conversation_ref !== `console:${consoleFlag}`) return false; }
          else if (targeted) return false;
          if (t.state === "READY" || t.state === "AWAITING_APPROVAL") return true;
          if (t.state === "SUCCEEDED" && (!t.result?.output_summary || !t.result.output_summary.includes("[ARGON-ACK]"))) {
            return true;
          }
          return false;
        });
        if (unacked) {
          const isAlert = unacked.kind === "system_alert" || unacked.kind === "github_alert";
          console.log(
            JSON.stringify(
              {
                wakeup: isAlert ? "MONITOR_ALERT_NOTIFICATION" : "NEW_CHATGPT_MONITOR_TASK",
                task_id: unacked.task_id,
                operation_id: unacked.operation_id,
                state: unacked.state,
                kind: unacked.kind,
                workspace_id: unacked.workspace_id,
                description: unacked.description,
                requested_actions: unacked.requested_actions,
                target_relpath: unacked.target_relpath,
                created_at: new Date(unacked.created_at).toISOString(),
              },
              null,
              2,
            ),
          );
          return;
        }
      } finally {
        db.close();
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(JSON.stringify({ wakeup: "TIMEOUT_NO_NEW_TASK", timeout_seconds: timeoutSec }));
  };

  if (sub === "wait-next") {
    const positionalSec = rest.find((a) => !a.startsWith("--"));
    const timeoutSec = Number(flag("--timeout-seconds", argsAll) ?? positionalSec ?? "3600");
    await waitNextUnackedTask(isNaN(timeoutSec) ? 3600 : timeoutSec);
    return;
  }

  if (sub === "ack" || (sub === "respond" && consoleFlag)) {
    const taskId = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--console" && rest[i - 1] !== "--summary" && rest[i - 1] !== "--pid");
    const consoleId = consoleFlag;
    const summaryText = flag("--summary", argsAll) ?? (sub === "ack" ? "Consola lista." : "Reporte de consola.");
    if (!consoleId) throw new Error("uso: isymcp monitor ack <task-id> --console <console-id> [--summary ...] (token en $ISYMCP_ACK_TOKEN o --token)");
    const token = flag("--token", argsAll) ?? process.env.ISYMCP_ACK_TOKEN ?? "";
    const pidArg = flag("--pid", argsAll);
    const kind = sub === "ack" ? "ack" : argsAll.includes("--complete") ? "complete" : argsAll.includes("--fail") ? "fail" : "progress";
    const { consoleReport } = await import("./console-registry");
    const { db, workerSecret, env } = openBridgeMonitorStack();
    try {
      const rec = consoleReport(db, { consoleId, token, kind, summary: summaryText, pid: pidArg ? Number(pidArg) : undefined, hmacSecret: workerSecret }, env);
      if (taskId && taskId !== rec.task_id) throw new Error(`DENY: task_console_mismatch: la consola ${consoleId} pertenece a ${rec.task_id}, no a ${taskId}`);
      console.log(JSON.stringify({ ok: true, kind, console: rec }, null, 2));
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "consoles") {
    const { listConsoles } = await import("./console-registry");
    const { db, env } = openBridgeMonitorStack();
    try {
      const rows = listConsoles(db, Number(flag("--limit", argsAll) ?? "20"), env);
      if (argsAll.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); return; }
      if (!rows.length) { console.log("sin consolas registradas"); return; }
      for (const c of rows) {
        console.log(`${c.console_id}\t${c.state}\tpid=${c.agent_pid ?? "-"}\talive=${c.alive ?? "?"}\ttask=${c.task_id}\ttoken_fp=${c.token_fp}\tevents=${c.events_count}\t${c.title}`);
      }
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "console-log") {
    const target = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--tail");
    if (!target) throw new Error("uso: isymcp monitor console-log <console-id|task-id> [--tail N]");
    const { readConsoleLog } = await import("./console-registry");
    const { db } = openBridgeMonitorStack();
    try {
      console.log(JSON.stringify(readConsoleLog(db, target, Number(flag("--tail", argsAll) ?? "50")), null, 2));
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "respond") {
    const taskId = rest.find((a) => !a.startsWith("--"));
    const summaryText = flag("--summary", argsAll) ?? "Confirmado personalmente por Argon.";
    const autoWait = argsAll.includes("--wait") || argsAll.includes("--auto-wait");
    const timeoutSec = Number(flag("--timeout-seconds", argsAll) ?? "3600");
    if (!taskId) throw new Error('uso: isymcp monitor respond <task-id> --summary "respuesta de Argon" [--wait]');
    const { db, monitor } = openBridgeMonitorStack();
    try {
      const task = monitor.inspectTask(taskId);
      if (!task) throw new Error(`no existe la tarea: ${taskId}`);
      const fullSummary = summaryText.includes("[ARGON-ACK]") ? summaryText : `[ARGON-ACK] ${summaryText}`;
      const artifactHash = sha256Prefixed(`${taskId}:${fullSummary}`);
      const now = Date.now();
      const resultObj = {
        exit_code: 0,
        output_summary: fullSummary,
        artifact_hash: artifactHash,
        completed_at: now,
      };
      db.query("UPDATE tasks SET state = 'SUCCEEDED', reason = 'argon_personal_response', result_json = ?, updated_at = ? WHERE task_id = ?").run(
        JSON.stringify(resultObj),
        now,
        taskId,
      );
      console.log(JSON.stringify({ ok: true, mode: "updated_with_argon_ack", auto_wait_next: autoWait, task: monitor.inspectTask(taskId) }, null, 2));
    } finally {
      db.close();
    }

    if (autoWait) {
      await waitNextUnackedTask(timeoutSec);
    }
    return;
  }

  if (sub === "alert" || sub === "notify") {
    const title = flag("--title", argsAll) ?? "Alerta de sistema";
    const explicitSummary = flag("--summary", argsAll);
    const positionalSummary = rest.filter((a) => !a.startsWith("--")).join(" ");
    const summary = explicitSummary ?? (positionalSummary.length > 0 ? positionalSummary : "Notificación enviada al monitor");
    const source = flag("--source", argsAll) ?? "system";
    const { openBridgeMonitorStack } = await import("./remote-monitor");
    const { db, queue } = openBridgeMonitorStack();
    try {
      const res = queue.submitAlertTask({ title, summary, source });
      console.log(JSON.stringify(res, null, 2));
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "tasks") {
    const { db, monitor } = openBridgeMonitorStack();
    try {
      const tasks = monitor.listTasks(50);
      if (argsAll.includes("--json")) {
        console.log(JSON.stringify(tasks, null, 2));
        return;
      }
      if (tasks.length === 0) {
        console.log("sin tareas en el buzón del monitor");
        return;
      }
      for (const t of tasks) {
        console.log(`${t.task_id}\t${t.state}\tws=${t.workspace_id}\tkind=${t.kind}\t${t.description}`);
        if (t.result) {
          console.log(`  ↳ resultado (exit=${t.result.exit_code}): ${t.result.output_summary}`);
        }
      }
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "approve") {
    const taskId = rest.find((a) => !a.startsWith("--"));
    if (!taskId) throw new Error("uso: isymcp monitor approve <task-id>");
    const { db, authority, monitor } = openBridgeMonitorStack();
    try {
      const task = monitor.inspectTask(taskId);
      if (!task) throw new Error(`no existe la tarea: ${taskId}`);
      const ogGrant = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["task:grant"] });
      const grant = authority.createTaskGrant(ogGrant, {
        workspace_id: task.workspace_id,
        allowed_kinds: [task.kind],
        allowed_actions: task.requested_actions.length > 0 ? task.requested_actions : ["tests:run"],
      });
      const ogApprove = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["task:grant"] });
      const updated = authority.authorizePendingTask(ogApprove, {
        task_id: taskId,
        grant_id: grant.grant_id,
      });
      console.log(`tarea aprobada: ${updated.task_id} -> state=${updated.state} (grant=${grant.grant_id})`);
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "lease") {
    const action = rest[0];
    const leaseArgs = rest.slice(1);
    const { db, authority } = openBridgeMonitorStack();
    try {
      if (action === "mint") {
        const wsId = flag("--workspace", leaseArgs) ?? "default-ws";
        const cwd = flag("--cwd", leaseArgs) ?? process.cwd();
        const ttlSeconds = Number(flag("--ttl-seconds", leaseArgs) ?? "7200");
        const autoGrant = leaseArgs.includes("--auto-grant");

        const ogWs = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["workspace:register"] });
        authority.registerWorkspace(ogWs, { workspace_id: wsId, root_path: cwd });

        const ogMint = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["lease:mint"] });
        const minted = authority.mintQueueLease(ogMint, {
          workspace_id: wsId,
          scopes: ["queue:submit", "queue:status"],
          ttlSeconds,
        });

        let autoGrantId: string | null = null;
        if (autoGrant) {
          const ogTaskGrant = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["task:grant"] });
          const tg = authority.createTaskGrant(ogTaskGrant, {
            workspace_id: wsId,
            allowed_kinds: ["verify_only", "review_and_test", "diagnostics"],
            allowed_actions: ["tests:run", "report:write", "status:read"],
            ttlSeconds,
          });
          autoGrantId = tg.grant_id;
        }

        console.log(`QueueLease emitido (tipo API-key por tiempo):`);
        console.log(`  token (turn_token): ${minted.token}`);
        console.log(`  lease_id:           ${minted.lease_id}`);
        console.log(`  workspace_id:       ${minted.workspace_id} (${cwd})`);
        console.log(`  scopes:             ${minted.scopes.join(", ")}`);
        console.log(`  expira:             ${new Date(minted.expires_at).toISOString()} (TTL=${ttlSeconds}s)`);
        console.log(`  tope absoluto:      ${new Date(minted.absolute_deadline).toISOString()}`);
        if (autoGrantId) {
          console.log(`  task_grant activo:  ${autoGrantId} (las tareas entrantes pasan directo a READY para el monitor continuo)`);
        }
        return;
      }

      if (action === "renew") {
        const leaseId = leaseArgs.find((a) => !a.startsWith("--"));
        const ttlSeconds = Number(flag("--ttl-seconds", leaseArgs) ?? "7200");
        if (!leaseId) throw new Error("uso: isymcp monitor lease renew <lease-id> --ttl-seconds <seg>");
        const ogRenew = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["lease:renew"] });
        const renewed = authority.renewQueueLease(ogRenew, {
          lease_id: leaseId,
          additionalTtlSeconds: ttlSeconds,
        });
        console.log(`QueueLease renovado: ${renewed.lease_id} · nueva expiracion=${new Date(renewed.expires_at).toISOString()} (gen=${renewed.generation})`);
        return;
      }

      if (action === "revoke") {
        const leaseId = leaseArgs.find((a) => !a.startsWith("--"));
        if (!leaseId) throw new Error("uso: isymcp monitor lease revoke <lease-id>");
        const ogRevoke = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["lease:revoke"] });
        const revoked = authority.revokeQueueLease(ogRevoke, leaseId);
        console.log(`QueueLease revocado inmediatamente: ${revoked.lease_id} (revoked_at=${new Date(revoked.revoked_at!).toISOString()})`);
        return;
      }
    } finally {
      db.close();
    }
    throw new Error("uso: isymcp monitor lease mint|renew|revoke ...");
  }

  throw new Error("uso: isymcp monitor start|stop|status|run|tasks|approve|lease|ack|consoles|console-log");
}
