#!/usr/bin/env bun
// e2e-chat-tools.ts — E2E REAL de la Fase 2: chat local con tools ON.
//   panel /api -> bridge -> Chrome -> chatgpt.com -> tunel -> MCP -> bwrap
//
// Verifica con evidencia del disco y de mcp-trace (no con lo que dice el
// modelo): la tool corrio, la tarjeta sale de la traza de ESE turno, el
// archivo existe, y los tokens de turno quedan revocados.
//
// Requiere el tunel conectado (isymcp tunnel connect). Usa el home real
// (~/.codex-web-http) porque el MCP del tunel lee de ahi el registro; al
// final borra SOLO lo que creo (sus chats por id, su sesion, su workspace).
//   bun run scripts/e2e-chat-tools.ts [BRIDGE_PORT] [PANEL_PORT]
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chatPath } from "../src/chats";
import { bridgeAuthHeaders } from "../src/local-guard";
import { mintSession, readSessions, revokeSession } from "../src/codex-sessions";

const ROOT = join(import.meta.dir, "..");
const BRIDGE_PORT = process.argv[2] ?? "8795";
const PANEL_PORT = process.argv[3] ?? "8794";
const tag = () => `${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const N_FILE = `NOTA${tag()}`;
const N_WRITE = `ESCRITO${tag()}`;

const scratch = join(ROOT, ".test-tmp");
mkdirSync(scratch, { recursive: true });
const ws = mkdtempSync(join(scratch, "e2e-tools-"));
writeFileSync(join(ws, "nota.txt"), `${N_FILE}\n`);
const session = mintSession(ws, { label: "e2e-chat-tools", writable: true, ttlHours: 1 });

const logDir = join(homedir(), ".codex-web-http", "run");
mkdirSync(logDir, { recursive: true });
const env = { ...process.env, CODEX_WEB_HTTP_PORT: BRIDGE_PORT, CODEX_WEB_HTTP_CONNECTOR: "" };
const bridge = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts")], {
  cwd: ROOT, env, stdin: "ignore", stdout: "ignore", stderr: openSync(join(logDir, "e2e-chat-tools-bridge.log"), "a"),
});
const panel = Bun.spawn(["bun", "-e", `import { startPanel } from ${JSON.stringify(join(ROOT, "src", "panel.ts"))}; startPanel(${PANEL_PORT}, ${JSON.stringify(BRIDGE_PORT)});`], {
  cwd: ROOT, env, stdin: "ignore", stdout: "ignore", stderr: "ignore",
});
const P = `http://127.0.0.1:${PANEL_PORT}`;
async function api(path: string, body?: unknown) {
  const res = await fetch(`${P}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const created: string[] = [];
const steps: Array<Record<string, unknown>> = [];
let pass = false;
const t0 = Date.now();
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`, { headers: bridgeAuthHeaders() })).ok && (await fetch(`${P}/api/chats`)).ok) break; } catch { /* arrancando */ }
    await Bun.sleep(500);
  }
  const chat = (await api("/api/chats", {})).json;
  created.push(chat.id);
  const cfg = await api(`/api/chats/${chat.id}/config`, { tools_enabled: true, session_fp: session.fp });
  if (cfg.status !== 200) throw new Error(`config: ${JSON.stringify(cfg.json)}`);

  const turn = async (label: string, message: string) => {
    const started = Date.now();
    const r = await api(`/api/chats/${chat.id}/messages`, { message });
    const reply = r.json.reply ?? { text: JSON.stringify(r.json.error ?? r.json), meta: {} };
    const step = { label, ok: r.json.ok === true, ms: Date.now() - started, reply: String(reply.text).slice(0, 200), kind: reply.meta?.kind, tools: reply.meta?.tools ?? [] };
    steps.push(step);
    console.log(`[e2e-tools ${label}] ok=${step.ok} ms=${step.ms} tools=${JSON.stringify(step.tools)} reply=${JSON.stringify(step.reply.slice(0, 80))}`);
    return step;
  };
  const read = await turn("leer", "Usa codex_exec para ejecutar [\"cat\",\"nota.txt\"] en la carpeta de trabajo y responde solo con el contenido del archivo.");
  const write = await turn("escribir", `Usa codex_exec para ejecutar ["sh","-c","printf ${N_WRITE} > escrito.txt"] y responde solo: listo.`);

  const readCard = (read.tools as any[]).find((c) => c.tool === "codex_exec" && c.summary === "cat nota.txt");
  const writeCard = (write.tools as any[]).find((c) => c.tool === "codex_exec" && String(c.summary).includes("escrito.txt"));
  const fileOk = existsSync(join(ws, "escrito.txt")) && readFileSync(join(ws, "escrito.txt"), "utf8") === N_WRITE;
  const leftoverTurnTokens = readSessions().filter((s) => s.kind === "turn" && s.parent === session.fp).length;
  steps.push({ label: "checks", readCard: Boolean(readCard), readCardOk: readCard?.state === "ok", writeCard: Boolean(writeCard), fileOk, leftoverTurnTokens });
  console.log(`[e2e-tools checks] readCard=${readCard?.state} writeCard=${writeCard?.state} fileOk=${fileOk} leftoverTurnTokens=${leftoverTurnTokens}`);
  pass = read.ok && String(read.reply).includes(N_FILE) && readCard?.state === "ok"
    && write.ok && writeCard?.state === "ok" && fileOk && leftoverTurnTokens === 0;
} finally {
  panel.kill();
  bridge.kill();
  await Promise.all([panel.exited, bridge.exited]);
  revokeSession(session.fp);
  for (const id of created) { const p = chatPath(id); if (p && existsSync(p)) unlinkSync(p); }
  rmSync(ws, { recursive: true, force: true });
}
const out = join(ROOT, "docs", "evidence", `e2e-chat-tools-${Date.now()}.json`);
mkdirSync(join(ROOT, "docs", "evidence"), { recursive: true });
writeFileSync(out, JSON.stringify({ ts: new Date().toISOString(), pass, totalMs: Date.now() - t0, steps }, null, 2));
console.log(JSON.stringify({ pass, out }));
process.exit(pass ? 0 : 1);
