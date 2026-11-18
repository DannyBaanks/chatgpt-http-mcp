import { VIEWS, type DashState, type HubServer, type StatusJson, type ViewId } from "./types";
import { keyLegend, viewLegend } from "./keys";
import { CANARY_STALE_MS, ageText, computeAlerts, hubServers, prettyHubLog, selected, sessionRows, taskRows, type AlertLevel } from "./ops";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const COLORS = {
  green: `${ESC}32m`,
  red: `${ESC}31m`,
  yellow: `${ESC}33m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  inverse: `${ESC}7m`,
};

const paint = (value: string, color: string) => `${color}${value}${RESET}`;
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function safe(value: unknown): string {
  return String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTADO]")
    .replace(/(["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTADO]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTADO]")
    .replace(/\btunnel_[a-f0-9]{32}\b/gi, "[REDACTADO]");
}

function charWidth(value: string): number {
  const cp = value.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(value)) return 0;
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (/\p{Emoji_Presentation}/u.test(value)) return 2;
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6))
  ) ? 2 : 1;
}

export function visibleWidth(value: string): number {
  return Array.from(stripAnsi(value)).reduce((width, char) => width + charWidth(char), 0);
}

function clip(value: string, width: number): string {
  if (width <= 0) return "";
  let used = 0;
  let out = "";
  const tokens = value.match(/\x1b\[[0-?]*[ -/]*[@-~]|[\s\S]/gu) ?? [];
  for (const token of tokens) {
    if (token.startsWith("\x1b[")) {
      out += token;
      continue;
    }
    const w = charWidth(token);
    if (used + w > width) break;
    out += token;
    used += w;
  }
  if (out.includes("\x1b[")) out += RESET;
  return out;
}

function fit(value: string, width: number): string {
  const fitted = clip(value, Math.max(0, width));
  const spaces = Math.max(0, width - visibleWidth(fitted));
  return fitted + " ".repeat(spaces);
}

function wrapWords(value: string, width: number): string[] {
  if (width <= 0) return [];
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (visibleWidth(word) > width) {
      if (line) lines.push(line);
      lines.push(clip(word, width));
      line = "";
      continue;
    }
    const next = line ? `${line} ${word}` : word;
    if (visibleWidth(next) > width) {
      if (line) lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function clockText(now: number): string {
  return new Date(now).toLocaleTimeString(undefined, { hour12: false });
}

function shortExpiry(value: string | null): string {
  if (!value) return "sin caducidad";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? safe(value) : date.toLocaleTimeString(undefined, { hour12: false });
}

function age(value: string, now: number): string {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return "edad desconocida";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function stateWord(label: string, up: boolean | null | undefined): string {
  if (up === null || up === undefined) return paint(`${label}: ?`, COLORS.gray);
  return paint(`${label}: ${up ? "UP" : "DOWN"}`, up ? COLORS.green : COLORS.gray);
}

function serviceLines(status: StatusJson | null, now: number): string[] {
  if (!status) return [paint("estado: sin datos", COLORS.gray)];
  const server = `${stateWord("server", status.server?.up)}${status.server?.pid ? ` pid=${status.server.pid}` : ""} ${safe(status.server?.url)}`.trim();
  const running = typeof status.tunnel?.running === "boolean" ? ` · proceso ${status.tunnel.running ? "vivo" : "parado"}` : "";
  const tunnel = `${stateWord("túnel", status.tunnel?.ready)} · ${safe(status.tunnel?.state || "sin datos")}${running}`;
  const panel = `${stateWord("panel", status.panel?.up)} · ${safe(status.panel?.url)}`;
  const monitor = `${stateWord("monitor", status.monitor?.up)}${status.monitor?.pid ? ` pid=${status.monitor.pid}` : ""} · ${safe(status.monitor?.url)}`;
  const mcp = stateWord("mcp", status.mcp?.up);
  const canary = status.canary
    ? `${paint(status.canary.ok ? "canario: OK" : "canario: FALLO", !status.canary.ok ? COLORS.red : now - Date.parse(status.canary.ts) > CANARY_STALE_MS ? COLORS.yellow : COLORS.green)} · hace ${age(status.canary.ts, now)}`
    : paint("canario: sin dato", COLORS.gray);
  const tasks = status.tasks ? `tareas: ${status.tasks.total} · bloqueadas: ${status.tasks.blocked}` : paint("tareas: sin dato", COLORS.gray);
  return [server, tunnel, panel, monitor, `${mcp} · ${canary}`, tasks];
}

function toolsCount(server: HubServer): string {
  if (Array.isArray(server.tools)) return String(server.tools.length);
  return server.tools == null ? "?" : safe(server.tools);
}

function hubStateColor(value: string): string {
  const state = value.toLowerCase();
  if (state === "ready") return COLORS.green;
  if (state === "direct") return COLORS.cyan;
  if (/fail|error|down|crash|dead|stopped/.test(state)) return COLORS.red;
  return COLORS.yellow;
}

function permissionLines(status: StatusJson | null): string[] {
  if (!status) return [paint("permisos: sin datos", COLORS.gray)];
  const gate = (label: string, value: { on: boolean; expires: string | null } | undefined) => {
    if (!value) return paint(`${label}: ?`, COLORS.gray);
    const word = value.on ? "ON" : "off";
    const line = value.on ? `${label}: ${word} · ${shortExpiry(value.expires)}` : `${label}: ${word}`;
    return paint(line, value.on ? COLORS.red : COLORS.gray);
  };
  const taint = status.taint?.tainted
    ? paint(`taint: MARCADO · hasta ${shortExpiry(status.taint.until)}`, COLORS.red)
    : paint("taint: limpio", COLORS.green);
  return [gate("shell", status.gates?.shell), gate("agents", status.gates?.agents), taint];
}

const VIEW_TITLES: Record<ViewId, string> = {
  resumen: "Resumen",
  hub: "Hub",
  tareas: "Tareas",
  sesiones: "Sesiones",
  logs: "Logs",
  salida: "Salida",
};

const LEVEL_STYLE: Record<AlertLevel, { mark: string; color: string }> = {
  crit: { mark: "✗", color: COLORS.red },
  warn: { mark: "!", color: COLORS.yellow },
  info: { mark: "·", color: COLORS.gray },
};

function helpLines(): string[] {
  return [
    paint("Centro de operaciones ISyMCP", COLORS.bold),
    "",
    paint("Vistas", COLORS.bold),
    "  1 Resumen   alertas con su arreglo: Enter lo ejecuta (o te lleva a la vista)",
    "  2 Hub       cada MCP: Enter detalle · K reinicia SOLO ese MCP · L su log",
    "  3 Tareas    Codex (bloqueadas: O abre la conversación) y buzón del monitor (Y aprueba)",
    "  4 Sesiones  X revoca la seleccionada · C revoca todas las caducadas",
    "  5 Logs      F cambia fuente (hub/server/túnel) · / filtra · H muestra el ruido de sondeo",
    "  6 Salida    la salida completa de los últimos comandos",
    "",
    paint("Servicios (en cualquier vista)", COLORS.bold),
    "  u up · d down · t/T túnel · p/P panel · o abrir panel · m/M monitor",
    "  c canary · D doctor · s/a permitir un uso · S/A cerrar permiso · x limpiar taint",
    "  r recargar hub (reinicia TODOS los MCP) · R reiniciar el servicio del hub",
    "  : paleta: cualquier comando isymcp (los destructivos piden y)",
    "",
    "Navegación: 1-6, Tab/Shift+Tab, ↑↓ o j/k, PgUp/PgDn, g/G · ? cierra esta ayuda · q sale",
  ];
}

function cursorRow(line: string, isSelected: boolean, width: number): string {
  const marked = `${isSelected ? "▸ " : "  "}${line}`;
  return isSelected ? paint(stripAnsi(fit(marked, width)), COLORS.inverse) : marked;
}

/** Ventana de filas alrededor del cursor para listas más largas que el alto disponible. */
function windowed(rows: string[], cursor: number, room: number): string[] {
  if (rows.length <= room || room <= 0) return rows;
  const start = Math.min(Math.max(0, cursor - Math.floor(room / 2)), rows.length - room);
  return rows.slice(start, start + room);
}

function resumenLines(state: DashState, width: number, room: number): string[] {
  const services = serviceLines(state.status, state.now);
  const permissions = permissionLines(state.status);
  const servers = hubServers(state);
  const hubSummary = state.hub === null
    ? paint("hub caído", COLORS.red)
    : (() => {
      const ready = servers.filter((s) => s.state === "ready").length;
      const direct = servers.filter((s) => s.state === "direct").length;
      const bad = servers.length - ready - direct;
      const procs = servers.reduce((n, s) => n + (s.instances ?? []).filter((i) => typeof i.pid === "number").length, 0);
      return `hub: ${paint(`${ready} listos`, COLORS.green)} · ${direct} direct${bad ? ` · ${paint(`${bad} con problemas`, COLORS.red)}` : ""} · ${procs} procesos`;
    })();
  const sessions = sessionRows(state);
  const expired = sessions.filter((s) => s.expired).length;
  const left = [
    paint("Servicios", COLORS.bold), ...services, hubSummary, "",
    paint("Permisos", COLORS.bold), ...permissions, "",
    paint("Sesiones", COLORS.bold), `${sessions.length - expired} vivas · ${expired} caducadas`,
  ];
  const alerts = computeAlerts(state.status, state.hub, state.now, state.monitorTasks);
  const cur = selected(state);
  const alertRows = alerts.length === 0
    ? [paint("  todo en orden", COLORS.green)]
    : alerts.map((a, i) => {
      const { mark, color } = LEVEL_STYLE[a.level];
      return cursorRow(`${paint(mark, color)} ${safe(a.text)}  ${paint(`[${a.fixLabel}]`, COLORS.cyan)}`, i === cur, width >= 110 ? Math.floor((width - 3) / 2) : width);
    });
  const crit = alerts.filter((a) => a.level === "crit").length;
  const title = paint(`Alertas (${alerts.length}${crit ? `, ${crit} críticas` : ""}) · Enter arregla`, COLORS.bold);
  if (width >= 110) {
    const column = Math.floor((width - 3) / 2);
    const right = [title, ...windowed(alertRows, cur, room - 1)];
    const rows = Math.max(left.length, right.length);
    return Array.from({ length: rows }, (_, index) => `${fit(left[index] ?? "", column)}   ${fit(right[index] ?? "", width - column - 3)}`);
  }
  return [title, ...windowed(alertRows, cur, Math.max(3, room - left.length - 2)), "", ...left];
}

function hubDetail(server: HubServer, now: number): string[] {
  const info = server.serverInfo as { name?: string; version?: string } | undefined;
  const lines = [
    paint(`── ${safe(server.server)} ──`, COLORS.bold),
    `aislamiento: ${safe(server.isolation)} · ${server.enabled ? "habilitado" : "deshabilitado"}${info?.name ? ` · ${safe(info.name)} ${safe(info.version ?? "")}` : ""}`,
  ];
  if (server.description) lines.push(...wrapWords(safe(server.description), 100).slice(0, 3));
  for (const inst of server.instances ?? []) {
    lines.push(`  ${safe(inst.id)} pid=${inst.pid ?? "-"} ${safe(inst.state)}${inst.client ? ` cliente=${safe(inst.client)}` : ""}${inst.ready_ms !== undefined ? ` listo en ${inst.ready_ms} ms` : ""}${inst.in_flight ? paint(` · ${inst.in_flight} en vuelo`, COLORS.yellow) : ""}`);
  }
  if ((server.instances ?? []).length === 0) lines.push(paint("  sin procesos (arranca en la próxima llamada)", COLORS.gray));
  if (server.error) lines.push(paint(`error: ${safe(server.error).slice(0, 400)}`, COLORS.red));
  void now;
  return lines;
}

function hubViewLines(state: DashState, width: number, room: number): string[] {
  if (state.loaded === false && state.hub === null) return [paint("cargando…", COLORS.gray)];
  if (state.hub === null) return [paint("hub caído · R reinicia el servicio isymcp-hub", COLORS.red)];
  const servers = hubServers(state);
  if (servers.length === 0) return [paint("sin MCP configurados", COLORS.gray)];
  const nameW = Math.min(24, Math.max(...servers.map((s) => safe(s.server).length)));
  const header = paint(`  ${"MCP".padEnd(nameW)}  ${"estado".padEnd(9)} ${"tools".padStart(5)}  ${"aisl.".padEnd(10)} inst  pids`, COLORS.dim);
  const cur = selected(state);
  const rows = servers.map((s, i) => {
    const insts = s.instances ?? [];
    const pids = insts.map((x) => x.pid ?? "-").join(",") || "-";
    const flying = insts.reduce((n, x) => n + (x.in_flight ?? 0), 0);
    const st = safe(s.state || "?");
    const line = `${safe(s.server).padEnd(nameW).slice(0, nameW)}  ${paint(st.padEnd(9), hubStateColor(s.state || ""))} ${toolsCount(s).padStart(5)}  ${safe(s.isolation).padEnd(10)} ${String(insts.length).padStart(4)}  ${safe(pids)}${flying ? paint(` ⇄${flying}`, COLORS.yellow) : ""}`;
    return cursorRow(line, i === cur, width);
  });
  const detail = state.expanded && servers[cur] ? ["", ...hubDetail(servers[cur]!, state.now)] : [];
  return [header, ...windowed(rows, cur, Math.max(3, room - 1 - detail.length)), ...detail];
}

function tareasViewLines(state: DashState, width: number, room: number): string[] {
  const rows = taskRows(state);
  const cur = selected(state);
  const codexCount = rows.filter((r) => r.kind === "codex").length;
  const out: string[] = [];
  const lines = rows.map((row, i) => {
    if (row.kind === "codex") {
      const t = row.task;
      const color = t.state === "bloqueada" ? COLORS.red : t.state === "en curso" ? COLORS.yellow : COLORS.green;
      const when = Number.isFinite(Date.parse(t.updated)) ? `hace ${ageText(state.now - Date.parse(t.updated))}` : "";
      const conv = t.conversation ? safe(t.conversation.replace(/^https:\/\/chatgpt\.com\/c\//, "c/")).slice(0, 20) : "sin conversación";
      return cursorRow(`codex   ${safe(t.id)}  ${paint(safe(t.state).padEnd(9), color)} turnos=${String(t.turns).padEnd(3)} ${when.padEnd(10)} ${conv}`, i === cur, width);
    }
    const t = row.task;
    const color = t.state === "AWAITING_APPROVAL" ? COLORS.yellow : /FAIL|DENIED|EXPIRED/.test(t.state) ? COLORS.red : /SUCCEEDED/.test(t.state) ? COLORS.green : COLORS.cyan;
    const when = typeof t.updated_at === "number" ? `hace ${ageText(state.now - t.updated_at)}` : "";
    return cursorRow(`monitor ${safe(t.task_id).slice(0, 22).padEnd(22)} ${paint(safe(t.state).padEnd(17), color)} ${when.padEnd(10)} ${safe(t.kind)} · ${safe(t.description)}`, i === cur, width);
  });
  const blocked = rows.filter((r) => r.kind === "codex" && r.task.state === "bloqueada").length;
  out.push(paint(`Codex: ${codexCount}${blocked ? ` (${blocked} bloqueadas: un envío quedó sin confirmar; revisa la conversación a mano, no se reenvía solo)` : ""} · Monitor: ${state.monitorTasks === null ? "sin datos" : state.monitorTasks.length}`, COLORS.dim));
  if (rows.length === 0) return [...out, paint("sin tareas", COLORS.gray)];
  let detail: string[] = [];
  const sel = rows[cur];
  if (state.expanded && sel) {
    if (sel.kind === "codex") {
      detail = ["", paint(`── tarea ${safe(sel.task.id)} ──`, COLORS.bold), `conversación: ${safe(sel.task.conversation ?? "—")}`, `actualizada: ${safe(sel.task.updated)} · turnos: ${sel.task.turns}`];
    } else {
      const t = sel.task;
      detail = ["", paint(`── ${safe(t.task_id)} ──`, COLORS.bold), `estado: ${safe(t.state)} · ws=${safe(t.workspace_id)} · kind=${safe(t.kind)} · intentos=${t.attempt_count ?? "?"}`,
        `acciones: ${safe((t.requested_actions ?? []).join(", ") || "—")}`, ...wrapWords(safe(t.description), Math.max(20, width - 2)).slice(0, 4)];
      if (t.result) detail.push(`resultado (exit=${t.result.exit_code ?? "?"}): ${safe(t.result.output_summary ?? "")}`);
    }
  }
  return [...out, ...windowed(lines, cur, Math.max(3, room - 1 - detail.length)), ...detail];
}

function sesionesViewLines(state: DashState, width: number, room: number): string[] {
  const sessions = sessionRows(state);
  if (sessions.length === 0) return [paint(state.status ? "sin sesiones de Codex" : "sin datos", COLORS.gray)];
  const cur = selected(state);
  const rows = sessions.map((s, i) => {
    const exp = s.expired ? paint("CADUCADA", COLORS.red) : s.expiresAt ? `caduca ${safe(s.expiresAt).slice(0, 16)}` : "sin caducidad";
    const cwd = safe(s.cwd ?? "").replace(/^\/home\/[^/]+/, "~");
    return cursorRow(`${s.writable ? paint("rw", COLORS.yellow) : "ro"}  ${safe(s.fp).slice(0, 12).padEnd(12)}  ${exp.padEnd(16)}  ${safe(s.label).slice(0, 32).padEnd(32)}  ${cwd}`, i === cur, width);
  });
  return [paint("Sesiones Codex ISyMCP (tokens nunca se muestran)", COLORS.dim), ...windowed(rows, cur, room - 1)];
}

function logViewLines(state: DashState, width: number, room: number): string[] {
  let lines = state.logSource === "hub" ? prettyHubLog(state.logLines, state.hideNoise) : state.logLines.map(safe);
  if (state.logFilter) lines = lines.filter((l) => l.toLowerCase().includes(state.logFilter.toLowerCase()));
  const tabs = (["hub", "server", "tunnel"] as const).map((s) => s === state.logSource ? paint(`[${s}]`, COLORS.cyan) : s).join(" ");
  const info = `${tabs} · ${lines.length} líneas${state.logFilter ? ` · filtro «${safe(state.logFilter)}»` : ""}${state.logSource === "hub" && state.hideNoise ? " · sin ruido de sondeo" : ""}`;
  const offset = Math.max(0, Math.min(state.cursor.logs, Math.max(0, lines.length - (room - 1))));
  const end = lines.length - offset;
  const visible = lines.slice(Math.max(0, end - (room - 1)), end).map((l) => fit(safe(l), width));
  return [paint(info, COLORS.dim), ...(visible.length ? visible : [paint("sin líneas", COLORS.gray)])];
}

function salidaViewLines(state: DashState, width: number, room: number): string[] {
  if (state.outputs.length === 0) return [paint("todavía no corriste comandos en esta sesión del dash", COLORS.gray)];
  const lines: string[] = [];
  for (const o of state.outputs) {
    const ok = o.code === 0;
    lines.push(paint(`${new Date(o.ts).toLocaleTimeString(undefined, { hour12: false })} $ ${safe(o.cmd)}  →  ${ok ? "OK" : `rc=${o.code}`} · ${(o.ms / 1000).toFixed(1)} s`, ok ? COLORS.green : COLORS.red));
    for (const l of o.lines) lines.push(`  ${safe(l)}`);
    lines.push("");
  }
  const offset = Math.max(0, Math.min(state.cursor.salida, Math.max(0, lines.length - room)));
  const end = lines.length - offset;
  return lines.slice(Math.max(0, end - room), end).map((l) => fit(l, width));
}

function contentLines(state: DashState, width: number, room: number): string[] {
  if (state.showHelp) return helpLines();
  const loading = state.loaded === false && state.status === null && state.hub === null;
  if (loading && state.view !== "salida" && state.view !== "logs") return [paint("cargando…", COLORS.gray)];
  switch (state.view) {
    case "resumen": return resumenLines(state, width, room);
    case "hub": return hubViewLines(state, width, room);
    case "tareas": return tareasViewLines(state, width, room);
    case "sesiones": return sesionesViewLines(state, width, room);
    case "logs": return logViewLines(state, width, room);
    case "salida": return salidaViewLines(state, width, room);
  }
}

function tabBar(state: DashState): string {
  const alerts = computeAlerts(state.status, state.hub, state.now, state.monitorTasks);
  const crit = alerts.filter((a) => a.level === "crit").length;
  const warn = alerts.filter((a) => a.level === "warn").length;
  const tabs = VIEWS.map((v, i) => {
    const label = `${i + 1} ${VIEW_TITLES[v]}`;
    return v === state.view ? paint(` ${label} `, `${COLORS.inverse}${COLORS.bold}`) : ` ${label} `;
  }).join("");
  const badge = !state.loaded && !state.status ? "" : crit ? paint(` ✗ ${crit} críticas`, COLORS.red) : warn ? paint(` ! ${warn} avisos`, COLORS.yellow) : paint(" ✓ en orden", COLORS.green);
  return `${tabs} ${badge}`;
}

export function renderFrame(state: DashState, width: number, height: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const spinner = ["|", "/", "-", "\\"][state.spinner % 4];
  const header = fit(paint("ISyMCP", `${COLORS.bold}${COLORS.cyan}`) + paint(" · centro de operaciones", COLORS.dim) + `  ${clockText(state.now)}` + (state.busy ? `  ${paint(spinner!, COLORS.yellow)} ejecutando` : ""), safeWidth);
  const tabs = fit(tabBar(state), safeWidth);
  const footer = [
    ...wrapWords(viewLegend(state.view), safeWidth).map((line) => paint(line, COLORS.cyan)),
    ...wrapWords(keyLegend(), safeWidth).map((line) => paint(line, COLORS.dim)),
  ];
  const bottom = state.input
    ? `${paint(state.input.mode === "palette" ? ": isymcp " : "/ ", COLORS.yellow)}${safe(state.input.text)}█`
    : state.message ? state.message.replace(/[\r\n\t]+/g, " ") : "";
  const fixed = 2 + footer.length + 1;
  const contentRoom = Math.max(0, safeHeight - fixed);
  const content = contentLines(state, safeWidth, contentRoom);
  const visibleContent = content.slice(0, contentRoom).map((line) => fit(line, safeWidth));
  const spacer = Math.max(0, contentRoom - visibleContent.length);
  const lines = [header, tabs, ...visibleContent, ...Array.from({ length: spacer }, () => ""), ...footer.map((line) => fit(line, safeWidth)), fit(clip(bottom, safeWidth), safeWidth)];
  return lines.slice(0, safeHeight).join("\n");
}

export function stripAnsiCodes(value: string): string {
  return stripAnsi(value);
}
