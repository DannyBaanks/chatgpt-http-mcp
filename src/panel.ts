// panel.ts — M13a: panel visual read-only del bridge (estilo ISyCo Worlds).
//   isymcp panel [--port 8798]   ->  http://127.0.0.1:8798
// GET / -> HTML; GET /api/state -> JSON. Sin acciones todavia (M13b).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSessions } from "./codex-sessions";

function pgrep(pattern: string): boolean {
  const p = Bun.spawnSync(["pgrep", "-f", pattern], { stdout: "ignore", stderr: "ignore" });
  return (p.exitCode ?? 1) === 0;
}

export interface PanelSession { label: string; fp: string; writable: boolean }
export interface PanelState {
  ts: string;
  server: "up" | "down";
  serverPort: string;
  tunnel: "ready" | "stopped";
  mcp: "up" | "down";
  browser: "ok" | "page-crashed";
  conversation: string | null;
  sessions: PanelSession[];
  lastErrors: string[];
}

export async function buildPanelState(bridgePort = "8791"): Promise<PanelState> {
  let server: "up" | "down" = "down";
  try {
    const r = await fetch(`http://127.0.0.1:${bridgePort}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) server = "up";
  } catch {
    /* down */
  }
  const home = process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http");
  let conversation: string | null = null;
  try {
    conversation = (JSON.parse(readFileSync(join(home, "sessions", "default.json"), "utf8")) as { conversationUrl?: string | null }).conversationUrl ?? null;
  } catch {
    /* sin sesion */
  }
  const lastErrors: string[] = [];
  try {
    const log = join(home, "run", "server.log");
    if (existsSync(log)) {
      lastErrors.push(...readFileSync(log, "utf8").split("\n").filter((l) => l.includes("FAILED")).slice(-5));
    }
  } catch {
    /* sin log */
  }
  const browserCrashed = lastErrors.some((l) => /Page crashed|Target crashed/.test(l));
  return {
    ts: new Date().toISOString(),
    server,
    serverPort: bridgePort,
    tunnel: pgrep("tunnel-client run") ? "ready" : "stopped",
    mcp: pgrep("mcp/main.ts --contract native --broker") ? "up" : "down",
    browser: browserCrashed ? "page-crashed" : "ok",
    conversation,
    sessions: readSessions().map((s) => ({ label: s.label, fp: s.fp, writable: s.writable })),
    lastErrors,
  };
}

export function renderPanel(state: PanelState): string {
  const dot = (ok: boolean) => `<span style="color:${ok ? "#3d3" : "#e33"}">●</span>`;
  const card = (title: string, body: string) =>
    `<div style="border:1px solid #2a2a2a;border-radius:10px;padding:14px 16px;background:#111;min-width:260px">`
    + `<div style="color:#8f8;letter-spacing:.08em;font-size:12px;margin-bottom:8px">${title}</div>${body}</div>`;
  const sessions = state.sessions.map((s) => `${s.writable ? "rw" : "ro"} ${s.label} [${s.fp}]`).join("<br>") || "(ninguna)";
  const errors = state.lastErrors.map((e) => `<div style="color:#e99;font-size:12px">${e.slice(0, 160)}</div>`).join("") || "(sin errores recientes)";
  return `<!doctype html><html><head><meta charset="utf-8"><title>ISyMCP Panel</title></head>
<body style="background:#0a0a0a;color:#ddd;font:14px system-ui;padding:24px">
<h1 style="color:#7f7">ISyMCP PANEL</h1>
<div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:14px">
${card("SERVER", `${dot(state.server === "up")} ${state.server} · :${state.serverPort}`)}
${card("TUNEL", `${dot(state.tunnel === "ready")} ${state.tunnel}`)}
${card("MCP STDIO", `${dot(state.mcp === "up")} ${state.mcp}`)}
${card("BROWSER", `${dot(state.browser === "ok")} ${state.browser}`)}
${card("CONVERSACION", `<div style="font-size:12px;word-break:break-all">${state.conversation ?? "(sin /c/ aun)"}</div>`)}
${card("SESIONES MCP", `<div style="font-size:12px">${sessions}</div>`)}
${card("ULTIMOS ERRORES", errors)}
</div>
<div style="margin-top:16px;color:#666;font-size:12px">read-only · M13a · ${state.ts}</div>
</body></html>`;
}

export function startPanel(port = 8798, bridgePort = process.env.CODEX_WEB_HTTP_PORT ?? "8791") {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const state = await buildPanelState(bridgePort);
      if (url.pathname === "/api/state") return Response.json(state);
      return new Response(renderPanel(state), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return server;
}
