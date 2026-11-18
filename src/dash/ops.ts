// src/dash/ops.ts — lógica pura del centro de operaciones: alertas con su arreglo, filas
// seleccionables por vista y acciones sobre el elemento seleccionado. Sin E/S: se prueba sola.
import type { CommandAction, DashAction } from "./keys";
import type { DashState, HubServer, MonitorTask, StatusJson, TaskItem, ViewId } from "./types";

export type AlertLevel = "crit" | "warn" | "info";

export interface Alert {
  level: AlertLevel;
  text: string;
  /** Qué hace Enter sobre la alerta. */
  fix: DashAction;
  fixLabel: string;
}

/** El canario se programa a diario: más de 26 h sin correr ya es un dato viejo. */
export const CANARY_STALE_MS = 26 * 3600_000;

const OK_HUB_STATES = new Set(["ready", "direct", "idle", "disabled"]);

export function cmd(args: string[], label: string, confirm?: string): CommandAction {
  return { kind: "command", key: "", args, label, ...(confirm ? { confirm } : {}) };
}

export function ageText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function hubRestartAction(server: HubServer): CommandAction {
  const procs = (server.instances ?? []).filter((i) => typeof i.pid === "number").length;
  return cmd(
    ["hub", "restart", server.server],
    `reiniciar ${server.server}`,
    `Reiniciar solo ${server.server} (${procs} proceso${procs === 1 ? "" : "s"}; sus llamadas en vuelo fallan, el resto del hub sigue)`,
  );
}

export function computeAlerts(status: StatusJson | null, hub: { servers: HubServer[] } | null, now: number, monitorTasks: MonitorTask[] | null = null): Alert[] {
  const alerts: Alert[] = [];
  const key = (k: string, label: string): DashAction => ({ kind: "key", key: k, label } as DashAction);
  if (!status) {
    alerts.push({ level: "crit", text: "sin estado del bridge (status --json falló)", fix: key("D", "doctor"), fixLabel: "D doctor" });
  } else {
    if (!status.server?.up) alerts.push({ level: "crit", text: "server DOWN: ChatGPT no llega al bridge", fix: key("u", "up"), fixLabel: "u up" });
    if (!status.tunnel?.ready) alerts.push({ level: "crit", text: `túnel no listo (${status.tunnel?.state || "?"})`, fix: key("t", "túnel"), fixLabel: "t conectar" });
    if (status.server?.up && !status.mcp?.up) alerts.push({ level: "warn", text: "mcp DOWN (el server está arriba)", fix: key("u", "up"), fixLabel: "u up" });
    if (!status.canary) {
      alerts.push({ level: "warn", text: "canario sin correr nunca", fix: key("c", "canary"), fixLabel: "c canary" });
    } else if (!status.canary.ok) {
      alerts.push({ level: "crit", text: `canario FALLÓ hace ${ageText(now - Date.parse(status.canary.ts))}`, fix: key("c", "canary"), fixLabel: "c canary" });
    } else if (now - Date.parse(status.canary.ts) > CANARY_STALE_MS) {
      alerts.push({ level: "warn", text: `canario viejo: último OK hace ${ageText(now - Date.parse(status.canary.ts))}`, fix: key("c", "canary"), fixLabel: "c canary" });
    }
    if (status.gates?.shell?.on) alerts.push({ level: "warn", text: "permiso shell ABIERTO", fix: key("S", "cerrar shell"), fixLabel: "S cerrar" });
    if (status.gates?.agents?.on) alerts.push({ level: "warn", text: "permiso agents ABIERTO", fix: key("A", "cerrar agents"), fixLabel: "A cerrar" });
    if (status.taint?.tainted) alerts.push({ level: "warn", text: "taint MARCADO (contenido no confiable en contexto)", fix: key("x", "limpiar taint"), fixLabel: "x limpiar" });
    if (status.tasks && status.tasks.blocked > 0) {
      const newest = (status.tasks.items ?? []).filter((t) => t.state === "bloqueada").map((t) => Date.parse(t.updated)).filter(Number.isFinite).sort((a, b) => b - a)[0];
      const when = newest ? ` (la más reciente hace ${ageText(now - newest)})` : "";
      alerts.push({ level: "warn", text: `${status.tasks.blocked} tareas de Codex bloqueadas${when}`, fix: { kind: "view", view: "tareas" }, fixLabel: "→ Tareas" });
    }
    const awaiting = (monitorTasks ?? []).filter((t) => t.state === "AWAITING_APPROVAL").length;
    if (awaiting > 0) alerts.push({ level: "warn", text: `${awaiting} tareas del monitor esperan tu aprobación`, fix: { kind: "view", view: "tareas" }, fixLabel: "→ Tareas (Y)" });
    if (!status.panel?.up) alerts.push({ level: "info", text: "panel web apagado", fix: key("p", "panel"), fixLabel: "p arrancar" });
    if (!status.monitor?.up) alerts.push({ level: "info", text: "monitor apagado (ChatGPT no puede encargar tareas)", fix: key("m", "monitor"), fixLabel: "m arrancar" });
    const expired = (status.sessions ?? []).filter((s) => s.expired).length;
    if (expired > 0) alerts.push({ level: "info", text: `${expired} sesiones caducadas en el registro`, fix: { kind: "view", view: "sesiones" }, fixLabel: "→ Sesiones" });
  }
  if (hub === null) {
    alerts.push({ level: "crit", text: "hub caído: ninguna TUI tiene MCP", fix: key("R", "reiniciar hub"), fixLabel: "R reiniciar" });
  } else {
    for (const server of hub.servers) {
      if (!server.enabled || OK_HUB_STATES.has(String(server.state).toLowerCase())) continue;
      const err = server.error ? ` · ${server.error.slice(0, 80)}` : "";
      alerts.push({ level: "crit", text: `MCP ${server.server}: ${server.state}${err}`, fix: hubRestartAction(server), fixLabel: "reiniciar MCP" });
    }
  }
  const rank: Record<AlertLevel, number> = { crit: 0, warn: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.level] - rank[b.level]);
}

export function hubServers(state: DashState): HubServer[] {
  return state.hub?.servers ?? [];
}

export function codexTasks(state: DashState): TaskItem[] {
  return state.status?.tasks?.items ?? [];
}

/** Filas de la vista Tareas: primero las de Codex, luego las del buzón del monitor. */
export type TaskRow = { kind: "codex"; task: TaskItem } | { kind: "monitor"; task: MonitorTask };

export function taskRows(state: DashState): TaskRow[] {
  return [
    ...codexTasks(state).map((task) => ({ kind: "codex" as const, task })),
    ...(state.monitorTasks ?? []).map((task) => ({ kind: "monitor" as const, task })),
  ];
}

export function sessionRows(state: DashState): StatusJson["sessions"] {
  return state.status?.sessions ?? [];
}

/** Cuántas filas seleccionables tiene una vista (logs/salida se desplazan, no seleccionan). */
export function rowCount(state: DashState, view: ViewId = state.view): number {
  switch (view) {
    case "resumen": return computeAlerts(state.status, state.hub, state.now, state.monitorTasks).length;
    case "hub": return hubServers(state).length;
    case "tareas": return taskRows(state).length;
    case "sesiones": return sessionRows(state).length;
    default: return 0;
  }
}

export function selected(state: DashState): number {
  const n = rowCount(state);
  return n === 0 ? 0 : Math.min(Math.max(0, state.cursor[state.view] ?? 0), n - 1);
}

/**
 * Teclas que dependen de la vista y del elemento seleccionado. Devuelve null si la tecla no
 * significa nada aquí (entonces se prueba como tecla global).
 */
export function viewKeyAction(key: string, state: DashState): DashAction | null {
  const i = selected(state);
  if (state.view === "resumen" && key === "enter") {
    const alert = computeAlerts(state.status, state.hub, state.now, state.monitorTasks)[i];
    return alert ? alert.fix : null;
  }
  if (state.view === "hub") {
    const server = hubServers(state)[i];
    if (!server) return null;
    if (key === "enter") return { kind: "toggleDetail" };
    if (key === "K") {
      if (server.state === "direct") return { kind: "note", text: `${server.server} es direct: cada TUI lanza el suyo, el hub no lo reinicia` };
      return hubRestartAction(server);
    }
    if (key === "L") return { kind: "logsFor", filter: server.server };
  }
  if (state.view === "tareas") {
    const row = taskRows(state)[i];
    if (!row) return null;
    if (key === "enter") return { kind: "toggleDetail" };
    if (key === "O" && row.kind === "codex") {
      return row.task.conversation ? { kind: "open", url: row.task.conversation } : { kind: "note", text: "esta tarea no tiene conversación guardada" };
    }
    if (key === "Y" && row.kind === "monitor") {
      if (row.task.state !== "AWAITING_APPROVAL") return { kind: "note", text: `la tarea ${row.task.task_id} está ${row.task.state}: no hay nada que aprobar` };
      const actions = row.task.requested_actions?.length ? row.task.requested_actions.join(",") : "tests:run";
      return cmd(["monitor", "approve", row.task.task_id], `aprobar ${row.task.task_id}`, `Aprobar ${row.task.task_id} (${row.task.kind}; acciones: ${actions}) en ${row.task.workspace_id}`);
    }
  }
  if (state.view === "sesiones") {
    const session = sessionRows(state)[i];
    if (key === "X" && session) {
      return cmd(["session", "revoke", session.fp], `revocar ${session.label}`, `Revocar la sesión «${session.label}» [${session.fp}]`);
    }
    if (key === "C") {
      const expired = sessionRows(state).filter((s) => s.expired);
      if (expired.length === 0) return { kind: "note", text: "no hay sesiones caducadas" };
      return { kind: "batch", label: "revocar caducadas", confirm: `Revocar ${expired.length} sesiones caducadas`, steps: expired.map((s) => ["session", "revoke", s.fp]) };
    }
  }
  if (state.view === "logs") {
    if (key === "F") return { kind: "cycleLogSource" };
    if (key === "/") return { kind: "startInput", mode: "filter" };
    if (key === "H") return { kind: "toggleNoise" };
  }
  return null;
}

/** Comandos de la paleta que necesitan `y` además de lo que marca el control center. */
const PALETTE_CONFIRM: Array<[RegExp, string]> = [
  [/^hub\s+(reload|stop|restart)\b/, "Toca procesos MCP que usan todas las TUIs"],
  [/^allow\b(?!.*\boff\b)/, "Abre un permiso"],
  [/^taint\s+clear\b/, "Limpia el taint"],
  [/^session\s+revoke\b/, "Revoca sesiones"],
  [/^(down|exec|sh)\b/, "Comando destructivo o de shell"],
  [/^(server|tunnel|panel|monitor)\s+stop\b/, "Detiene un servicio"],
];

/** Comandos que no tienen sentido dentro del panel (interactivos o que no terminan). */
const PALETTE_BLOCKED: Array<[RegExp, string]> = [
  [/^dash\b/, "ya estás en el dash"],
  [/^(tui|menu|ask|chat)\b/, "es interactivo: córrelo en otra terminal"],
  [/^monitor\s+(run|wait-next)\b/, "no termina: usa m para arrancar el monitor"],
  [/^hub\s+(serve|connect)\b/, "no termina: lo arranca systemd"],
  [/^session(\s+default)?\s*$/, "abre un navegador interactivo"],
];

export function splitArgs(text: string): string[] {
  const parts = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const args = parts.map((p) => p.replace(/^["']|["']$/g, ""));
  return args[0] === "isymcp" ? args.slice(1) : args;
}

export function paletteAction(text: string): DashAction {
  const args = splitArgs(text.trim());
  if (args.length === 0) return { kind: "note", text: "paleta vacía" };
  const line = args.join(" ");
  for (const [re, why] of PALETTE_BLOCKED) if (re.test(line)) return { kind: "note", text: `isymcp ${line}: ${why}` };
  const confirm = PALETTE_CONFIRM.find(([re]) => re.test(line))?.[1];
  return { ...cmd(args, `isymcp ${line}`, confirm ? `${confirm}: isymcp ${line}` : undefined), toOutput: true };
}

const NOISE_CLIENT = "isymcp-hub-status";

/**
 * Log del hub (JSON por línea) a texto legible. Sin `hideNoise` no se quita nada; con él se
 * ocultan las conexiones de sondeo del propio dash y de `hub status` (una cada refresco).
 */
export function prettyHubLog(lines: string[], hideNoise: boolean): string[] {
  const noisy = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(raw) as Record<string, unknown>; } catch { out.push(raw); continue; }
    const client = typeof ev.client === "string" ? ev.client : "";
    if (hideNoise && ev.event === "client_connected" && String(ev.info ?? "").startsWith(NOISE_CLIENT)) { noisy.add(client); continue; }
    if (hideNoise && ev.event === "client_disconnected" && noisy.has(client)) { noisy.delete(client); continue; }
    const ms = typeof ev.ts === "string" ? Date.parse(ev.ts) : NaN;
    const ts = Number.isFinite(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour12: false }) : "--:--:--";
    const rest = Object.entries(ev).filter(([k]) => k !== "ts" && k !== "event")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
    out.push(`${ts} ${String(ev.event ?? "?")} ${rest}`.trimEnd());
  }
  return out;
}
