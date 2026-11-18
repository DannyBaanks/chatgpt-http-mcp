import type { DashState, HubServer, StatusJson } from "./types";
import { keyLegend } from "./keys";

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
  const tunnel = `${stateWord("túnel", status.tunnel?.ready)} · ${safe(status.tunnel?.state || "sin datos")} · running=${status.tunnel?.running ?? "?"}`;
  const panel = `${stateWord("panel", status.panel?.up)} · ${safe(status.panel?.url)}`;
  const monitor = `${stateWord("monitor", status.monitor?.up)}${status.monitor?.pid ? ` pid=${status.monitor.pid}` : ""} · ${safe(status.monitor?.url)}`;
  const mcp = stateWord("mcp", status.mcp?.up);
  const canary = status.canary
    ? `${paint(status.canary.ok ? "canario: OK" : "canario: FALLO", status.canary.ok ? COLORS.green : COLORS.red)} · ${age(status.canary.ts, now)}`
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

function hubLines(servers: HubServer[] | null): string[] {
  if (servers === null) return [paint("hub caído", COLORS.red)];
  if (servers.length === 0) return [paint("sin MCP configurados", COLORS.gray)];
  return servers.map((server) => {
    const instances = Array.isArray(server.instances) ? server.instances : [];
    const pids = instances.map((instance) => instance.pid ?? "-").join(",") || "-";
    const stateText = safe(server.state || "?");
    const state = paint(stateText, hubStateColor(server.state || ""));
    return `${safe(server.server)} · ${safe(server.isolation)} · ${state} · tools=${toolsCount(server)} · inst=${instances.length} · pid=${safe(pids)}`;
  });
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

function sessionLines(status: StatusJson | null): string[] {
  if (!status || !Array.isArray(status.sessions)) return [paint("sesiones: sin datos", COLORS.gray)];
  const expired = status.sessions.filter((session) => session.expired).length;
  return [`sesiones: ${status.sessions.length - expired} vivas · ${expired} caducadas`];
}

function helpLines(): string[] {
  return [
    "u up · d down (confirma)",
    "t conectar túnel · T detener túnel · p/P panel · o abrir panel",
    "m/M monitor · r recargar hub · R reiniciar hub (confirma)",
    "c canary · D doctor · s/a permitir un uso (confirma) · S/A cerrar permiso",
    "x limpiar taint (confirma) · l logs · ? volver · q salir",
  ];
}

function contentLines(state: DashState, width: number): string[] {
  if (state.showHelp) return helpLines();
  if (state.showLog) return state.logLines.length ? state.logLines.map(safe) : [paint("sin líneas de log", COLORS.gray)];

  const loading = state.loaded === false && state.status === null && state.hub === null;
  const wait = [paint("cargando…", COLORS.gray)];
  const services = loading ? wait : serviceLines(state.status, state.now);
  const hub = loading ? wait : hubLines(state.hub?.servers ?? null);
  const permissions = loading ? wait : permissionLines(state.status);
  const sessions = loading ? wait : sessionLines(state.status);
  if (width >= 110) {
    const column = Math.floor((width - 3) / 2);
    const left = [
      paint("Servicios", COLORS.bold), ...services, "",
      paint("Permisos", COLORS.bold), ...permissions, "",
      paint("Sesiones", COLORS.bold), ...sessions,
    ];
    const right = [paint("Hub", COLORS.bold), ...hub];
    const rows = Math.max(left.length, right.length);
    return Array.from({ length: rows }, (_, index) => `${fit(left[index] ?? "", column)}   ${fit(right[index] ?? "", width - column - 3)}`);
  }
  return [
    paint("Servicios", COLORS.bold), ...services, "",
    paint("Hub", COLORS.bold), ...hub, "",
    paint("Permisos", COLORS.bold), ...permissions, "",
    paint("Sesiones", COLORS.bold), ...sessions,
  ];
}

export function renderFrame(state: DashState, width: number, height: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const spinner = ["|", "/", "-", "\\"][state.spinner % 4];
  const header = fit(paint("ISyMCP", `${COLORS.bold}${COLORS.cyan}`) + `  ${clockText(state.now)}` + (state.busy ? `  ${paint(spinner, COLORS.yellow)} ejecutando` : ""), safeWidth);
  const footer = wrapWords(keyLegend(), safeWidth).map((line) => paint(line, COLORS.dim));
  const message = state.message ? clip(state.message.replace(/[\r\n\t]+/g, " "), safeWidth) : "";
  const content = contentLines(state, safeWidth);
  const fixed = 1 + footer.length + 1;
  const contentRoom = Math.max(0, safeHeight - fixed);
  const visibleContent = content.slice(0, contentRoom).map((line) => fit(line, safeWidth));
  const spacer = Math.max(0, safeHeight - (1 + visibleContent.length + footer.length + 1));
  const lines = [header, ...visibleContent, ...Array.from({ length: spacer }, () => ""), ...footer.map((line) => fit(line, safeWidth)), fit(message, safeWidth)];
  return lines.slice(0, safeHeight).join("\n");
}

export function stripAnsiCodes(value: string): string {
  return stripAnsi(value);
}
