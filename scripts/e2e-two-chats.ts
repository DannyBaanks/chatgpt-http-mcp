#!/usr/bin/env bun
// e2e-two-chats.ts — E2E REAL del chat local: dos chats, dos /c/, contextos
// independientes. Va por el mismo camino que la UI: panel /api/chats* -> bridge
// /isymcp/chat/turn -> Chrome -> chatgpt.com.
//
//   bun run scripts/e2e-two-chats.ts [BRIDGE_PORT] [PANEL_PORT]
//
// El registro local de chats va a un CODEX_WEB_HTTP_HOME temporal (no ensucia
// tu lista); las dos conversaciones SI se crean en tu cuenta de chatgpt.com.
// Evidencia: docs/evidence/e2e-two-chats-<ts>.json
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BRIDGE_PORT = process.argv[2] ?? "8795";
const PANEL_PORT = process.argv[3] ?? "8794";
const tmpHome = mkdtempSync(join(tmpdir(), "isymcp-e2e-chats-"));
const nonce = (tag: string) => `${tag}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const NA = nonce("ALFA");
const NB = nonce("BRAVO");

const env = {
  ...process.env,
  CODEX_WEB_HTTP_HOME: tmpHome,
  CODEX_WEB_HTTP_PORT: BRIDGE_PORT,
  // Sin tools en Fase 1: el turno de chat ya fuerza connector "", esto es extra.
  CODEX_WEB_HTTP_CONNECTOR: "",
  // El storage-state real vive en ~/.codex-web-http aunque el HOME del bridge sea temporal.
  CODEX_WEB_HTTP_STATE_PATH: process.env.CODEX_WEB_HTTP_STATE_PATH ?? join(homedir(), ".codex-web-http", "storage-state.json"),
};
const logDir = join(homedir(), ".codex-web-http", "run");
mkdirSync(logDir, { recursive: true });
const bridge = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts")], {
  cwd: ROOT, env, stdin: "ignore", stdout: "ignore", stderr: openSync(join(logDir, "e2e-two-chats-bridge.log"), "a"),
});
const panel = Bun.spawn(["bun", "-e", `import { startPanel } from ${JSON.stringify(join(ROOT, "src", "panel.ts"))}; startPanel(${PANEL_PORT}, ${JSON.stringify(BRIDGE_PORT)});`], {
  cwd: ROOT, env, stdin: "ignore", stdout: "ignore", stderr: "ignore",
});

const P = `http://127.0.0.1:${PANEL_PORT}`;
async function api(path: string, body?: unknown) {
  const res = await fetch(`${P}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

interface Step { chat: string; prompt: string; ok: boolean; reply: string; kind?: string; ms: number; url: string | null }
const steps: Step[] = [];
const t0 = Date.now();
let pass = false;
let urls: Record<string, string | null> = {};
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`)).ok && (await fetch(`${P}/api/chats`)).ok) break; } catch { /* arrancando */ }
    await Bun.sleep(500);
  }
  const A = (await api("/api/chats", {})).json.id as string;
  const B = (await api("/api/chats", {})).json.id as string;
  const turn = async (label: string, id: string, prompt: string) => {
    const started = Date.now();
    const r = await api(`/api/chats/${id}/messages`, { message: prompt });
    const reply = r.json.reply ?? { text: JSON.stringify(r.json.error ?? r.json), meta: {} };
    const chat = (await api(`/api/chats/${id}`)).json;
    steps.push({ chat: label, prompt, ok: r.json.ok === true, reply: String(reply.text).slice(0, 200), kind: reply.meta?.kind, ms: Date.now() - started, url: chat.conversation_url ?? null });
    console.log(`[e2e ${label}] ok=${r.json.ok} ms=${Date.now() - started} url=${chat.conversation_url ?? "-"} reply=${JSON.stringify(String(reply.text).slice(0, 80))}`);
    return String(reply.text);
  };
  const remember = (w: string) => `Palabra clave de ESTE chat: ${w}. No la guardes en memoria. Responde solo: OK`;
  const ask = "¿Cuál es la palabra clave de este chat? Responde solo la palabra, sin nada más.";
  await turn("A", A, remember(NA));
  await turn("B", B, remember(NB));
  const a2 = await turn("A", A, ask);
  const b2 = await turn("B", B, ask);
  urls = { A: (await api(`/api/chats/${A}`)).json.conversation_url, B: (await api(`/api/chats/${B}`)).json.conversation_url };
  const canonical = (u: string | null) => Boolean(u && /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]+$/.test(u));
  pass = steps.every((s) => s.ok)
    && canonical(urls.A!) && canonical(urls.B!) && urls.A !== urls.B
    && a2.includes(NA) && !a2.includes(NB)
    && b2.includes(NB) && !b2.includes(NA);
} finally {
  panel.kill();
  bridge.kill();
  await Promise.all([panel.exited, bridge.exited]);
  rmSync(tmpHome, { recursive: true, force: true });
}
const summary = { ts: new Date().toISOString(), pass, nonces: { A: NA, B: NB }, urls_distinct: urls.A !== urls.B, totalMs: Date.now() - t0, steps };
mkdirSync(join(ROOT, "docs", "evidence"), { recursive: true });
const out = join(ROOT, "docs", "evidence", `e2e-two-chats-${Date.now()}.json`);
// Las /c/ reales no van a la evidencia publica: se guarda solo que eran distintas.
writeFileSync(out, JSON.stringify({ ...summary, steps: steps.map((s) => ({ ...s, url: s.url ? "chatgpt.com/c/<redacted>" : null })) }, null, 2));
console.log(JSON.stringify({ pass, out }));
process.exit(pass ? 0 : 1);
