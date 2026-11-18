// src/cli/commands/status.ts — `isymcp status` (y la sesión del menú).
import { bridgeHome, isExpired, listUserSessions } from "../../codex-sessions";
import { CONNECTOR_NAME } from "../../mcp/identity";
import { processMatches } from "../../platform/process";
import { activeTaint } from "../../taint";
import { fileGrant, permissionSource, type Capability } from "../../permissions";
import type { StatusJson } from "../../dash/types";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOG, MONITOR_PID, MONITOR_URL, PANEL_URL, PORT, alive, bridgeJson, monitorUp, panelUp, readPid, serverUp, tunnel, tunnelState } from "../services";
import { describeSeen } from "./settings";
import { codexSession } from "./codex";

export type { StatusJson };

const STATUS_SCHEMA = "isymcp-status/1";

function livePid(file?: string): number | null {
  try {
    const pid = file === undefined ? readPid() : readPid(file);
    return pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function gateState(cap: Capability): { on: boolean; expires: string | null } {
  try {
    const src = permissionSource(cap);
    return { on: src !== null, expires: src === "file" ? fileGrant(cap).until : null };
  } catch {
    return { on: false, expires: null };
  }
}

/**
 * Estado completo del bridge como objeto (contrato `isymcp-status/1`, lo consume `isymcp dash`).
 * Cada sección que falla se reporta como null (o como su valor "cerrado"); nunca lanza.
 */
export async function collectStatus(): Promise<StatusJson> {
  const up = await serverUp().catch(() => false);
  const monitorUpNow = await monitorUp().catch(() => false);
  const panelUpNow = await panelUp().catch(() => false);

  let mcpUp = false;
  try { mcpUp = processMatches("src/mcp/main.ts --contract"); } catch { /* sin proceso */ }

  let conversation: string | null = null;
  try {
    const sessFile = join(bridgeHome(), "sessions", "default.json");
    if (existsSync(sessFile)) {
      conversation = (JSON.parse(readFileSync(sessFile, "utf8")) as { conversationUrl?: string | null }).conversationUrl ?? null;
    }
  } catch { /* registro ilegible = sin conversación */ }

  let sessions: StatusJson["sessions"] = [];
  try {
    sessions = listUserSessions().map((s) => ({ label: s.label, fp: s.fp, writable: s.writable, expired: isExpired(s) }));
  } catch { /* registro ilegible = sin sesiones listables */ }

  let chatgpt: string | null = null;
  if (up) {
    try {
      const st = await bridgeJson("/isymcp/settings", "GET", 3_000);
      chatgpt = describeSeen(st.body?.seen);
    } catch { /* opcional */ }
  }

  let canary: StatusJson["canary"] = null;
  try {
    const { readLatestCanary } = await import("../../canary");
    const c = readLatestCanary();
    if (c) canary = { ok: c.ok === true, ts: String(c.ts) };
  } catch { /* opcional */ }

  let tasks: StatusJson["tasks"] = null;
  try {
    const { listCodexTasks } = await import("../../codex-tasks");
    const list = listCodexTasks();
    tasks = { total: list.length, blocked: list.filter((t) => t.state === "bloqueada").length };
  } catch { /* opcional */ }

  let taint: StatusJson["taint"] = { tainted: false, until: null };
  try {
    const t = activeTaint();
    taint = { tainted: t !== null, until: t?.until ?? null };
  } catch { /* sin estado = limpio, como en `isymcp taint status` */ }

  return {
    version: STATUS_SCHEMA,
    ts: new Date().toISOString(),
    server: { up, url: `http://127.0.0.1:${PORT}`, pid: livePid(), log: LOG },
    tunnel: tunnelState(),
    mcp: { up: mcpUp },
    connector: process.env.CODEX_WEB_HTTP_CONNECTOR ?? CONNECTOR_NAME,
    conversation,
    sessions,
    panel: { up: panelUpNow, url: PANEL_URL },
    monitor: { up: monitorUpNow, url: MONITOR_URL, pid: livePid(MONITOR_PID) },
    chatgpt,
    canary,
    tasks,
    gates: { shell: gateState("host_shell"), agents: gateState("agent_spawn") },
    taint,
  };
}

export async function status(opts: { json?: boolean } = {}): Promise<void> {
  if (opts.json) {
    console.log(JSON.stringify(await collectStatus(), null, 2));
    return;
  }
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
    const sessFile = join(bridgeHome(), "sessions", "default.json");
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
    const { readLatestCanary } = await import("../../canary");
    const c = readLatestCanary();
    console.log(`  canario  ${c ? `${c.ok ? "OK" : "FALLO"} · ${c.ts}` : "sin correr (isymcp canary)"}`);
  } catch { /* opcional */ }
  try {
    const { listCodexTasks } = await import("../../codex-tasks");
    const tasks = listCodexTasks();
    const blocked = tasks.filter((t) => t.state === "bloqueada").length;
    console.log(`  tareas   ${tasks.length} de Codex${blocked ? ` (${blocked} bloqueadas: ver panel)` : ""}`);
  } catch { /* opcional */ }
}

export async function menuSession(sub: string, rest: string[]): Promise<void> {
  try {
    codexSession(sub, rest);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
  }
}
