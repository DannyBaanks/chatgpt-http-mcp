#!/usr/bin/env bun
// soak.ts — M9: N turnos secuenciales HTTP con nonce unico por turno.
// Cada turno ademas se REPITE con el mismo x-isymcp-turn-id para verificar el
// replay de idempotencia (x-isymcp-replayed: 1, sin re-ejecucion).
//   bun run scripts/soak.ts [N] [PORT]
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildChatGPTCommand } from "../src/mcp/identity";

const ROOT = join(import.meta.dir, "..");
const HOME = join(homedir(), ".codex-web-http");
const N = Number(process.argv[2] ?? "100");
const PORT = process.argv[3] ?? "8797";

const sessions = (JSON.parse(readFileSync(join(HOME, "codex-sessions.json"), "utf8")) as {
  sessions: Array<{ token: string; label: string }>;
}).sessions;
const session = sessions.find((s) => s.label === "codex-web-http-e2e-rw") ?? sessions[0];
if (!session) { console.error("soak: sin sesion en el registro"); process.exit(2); }

const server = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts")], {
  cwd: ROOT,
  env: { ...process.env, CODEX_WEB_HTTP_PORT: PORT, CODEX_WEB_HTTP_CONNECTOR: "Codex ISyMCP" },
  stdin: "ignore", stdout: "ignore",
  stderr: (() => { mkdirSync(join(HOME, "run"), { recursive: true }); return openSync(join(HOME, "run", "soak-server.log"), "a"); })(),
});

interface Result { i: number; nonce: string; ok: boolean; replayed: string | null; ms: number; http: string }
const results: Result[] = [];
const t0 = Date.now();
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* arrancando */ } await Bun.sleep(500); }
  for (let i = 1; i <= N; i++) {
    const nonce = `SOAK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const turnId = `soak-${i}-${nonce}`;
    const content = buildChatGPTCommand(`Ejecuta con codex_exec ["echo","${nonce}"] y responde EXACTAMENTE la salida del comando.`, { turnToken: session.token });
    const body = JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", messages: [{ role: "user", content }] });
    const started = Date.now();
    let ok = false; let http = ""; let replayed: string | null = null;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", "x-isymcp-turn-id": turnId }, body,
      });
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown };
      http = data.choices?.[0]?.message?.content ?? JSON.stringify(data.error ?? data).slice(0, 120);
      ok = String(http).trim() === nonce;
      const res2 = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", "x-isymcp-turn-id": turnId }, body,
      });
      replayed = res2.headers.get("x-isymcp-replayed");
      if (replayed !== "1") ok = false;
    } catch (err) { http = String(err).slice(0, 120); }
    results.push({ i, nonce, ok, replayed, ms: Date.now() - started, http: http.slice(0, 160) });
    console.log(`[soak ${i}/${N}] ok=${ok} replay=${replayed} ms=${Date.now() - started}`);
    // M13c: fail-fast — infra muerta no se martilla 70 veces
    const fastFail = !ok && Date.now() - started < 2000 && /crashed|closed|ECONNREFUSED|Unable to connect|fetch failed/i.test(http);
    if (fastFail) { console.error(`[soak] ABORT: infraestructura caida en turno ${i}: ${http.slice(0, 120)}`); break; }
  }
} finally {
  server.kill();
  await server.exited;
}
const summary = {
  ts: new Date().toISOString(), n: N,
  ok: results.filter((r) => r.ok).length,
  fail: results.filter((r) => !r.ok).length,
  totalMs: Date.now() - t0, results,
};
mkdirSync(join(ROOT, "docs", "evidence"), { recursive: true });
const out = join(ROOT, "docs", "evidence", `soak-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ok: summary.ok, fail: summary.fail, out }));
process.exit(summary.fail === 0 ? 0 : 1);
