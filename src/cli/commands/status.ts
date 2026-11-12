// src/cli/commands/status.ts — `isymcp status` (y la sesión del menú).
import { listUserSessions } from "../../codex-sessions";
import { CONNECTOR_NAME } from "../../mcp/identity";
import { processMatches } from "../../platform/process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOG, MONITOR_PID, MONITOR_URL, PANEL_URL, PORT, alive, bridgeJson, monitorUp, panelUp, readPid, serverUp, tunnel } from "../services";
import { describeSeen } from "./settings";
import { codexSession } from "./codex";

export async function status(): Promise<void> {
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
