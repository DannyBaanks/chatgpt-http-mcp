// src/cli/services.ts — Rutas, puertos y ciclo de vida de server, panel, monitor y túnel (movido de isymcp.ts).
import { bridgeHome } from "../codex-sessions";
import { bridgeAuthHeaders } from "../local-guard";
import { CONNECTOR_NAME } from "../mcp/identity";
import { stopProcessTree } from "../platform/process";
import { assertExclusiveTunnel, configuredTunnelAlias, tunnelClientPath } from "../tunnel-routing";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { status } from "./commands/status";
import { ROOT } from "./root";

export const PORT = process.env.CODEX_WEB_HTTP_PORT?.trim() || "8791";

export const RUN = join(bridgeHome(), "run");

export const SERVER_SUFFIX = PORT === "8791" ? "" : `-${PORT}`;

export const PID = join(RUN, `server${SERVER_SUFFIX}.pid`);

export const LOG = join(RUN, `server${SERVER_SUFFIX}.log`);

export const PANEL_PID = join(RUN, "panel.pid");

export const PANEL_LOG = join(RUN, "panel.log");

export const PANEL_PORT = process.env.ISYMCP_PANEL_PORT?.trim() || "8798";

export const PANEL_URL = `http://127.0.0.1:${PANEL_PORT}`;

export const MONITOR_PID = join(RUN, "monitor.pid");

export const MONITOR_LOG = join(RUN, "monitor.log");

export const MONITOR_PORT = process.env.ISYMCP_MONITOR_PORT?.trim() || "8799";

export const MONITOR_URL = `http://127.0.0.1:${MONITOR_PORT}`;

export const BRIDGE = `http://127.0.0.1:${PORT}`;

export function sh(cmd: string[], timeout = 20_000): { code: number; out: string } {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout });
  return { code: proc.exitCode ?? 1, out: proc.stdout.toString() + proc.stderr.toString() };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPid(file = PID): number | null {
  if (!existsSync(file)) return null;
  const n = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: bridgeAuthHeaders(), signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function startServer(options: { connector?: string | null } = {}): void {
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

export function stopServer(): void {
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

export async function panelUp(): Promise<boolean> {
  try {
    // /ready responde sin calcular el estado: preguntar por "/" obligaba al panel a
    // construirlo (segundos en Windows) dentro de los 1500 ms de este sondeo.
    const res = await fetch(`${PANEL_URL}/ready`, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startPanelDetached(): Promise<boolean> {
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

export function stopPanel(): void {
  const pid = readPid(PANEL_PID);
  if (pid && alive(pid)) {
    stopProcessTree(pid);
    console.log(`panel parado (pid ${pid})`);
  } else {
    console.log("panel no estaba corriendo (o lo levantaste en primer plano: Ctrl+C alli)");
  }
  try { writeFileSync(PANEL_PID, ""); } catch { /* pid file opcional */ }
}

export async function monitorUp(port = MONITOR_PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startMonitorDetached(port = MONITOR_PORT, inboxOnly = false): Promise<boolean> {
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

export function stopMonitor(): void {
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

export function openInBrowser(url: string): void {
  try {
    const child = spawn(process.platform === "win32" ? "explorer.exe" : "xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => console.log(`abre a mano: ${url}`));
    child.unref();
    console.log(`abriendo ${url}`);
  } catch {
    console.log(`abre a mano: ${url}`);
  }
}

export async function openPanel(pathOrHash = ""): Promise<void> {
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

export async function bridgeJson(path: string, method = "GET"): Promise<{ status: number; body: Record<string, unknown> | null }> {
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

export function tunnelBin(): string {
  return tunnelClientPath(bridgeHome());
}

export function tunnel(action: string): void {
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
