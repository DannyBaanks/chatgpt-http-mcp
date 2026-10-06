#!/usr/bin/env bun
// closure-baseline.ts — M1 del plan de cierre: baseline reproducible.
// Corre `bun test` + un E2E nonce por HTTP real y emite JSON con:
// tests, resultado E2E (HTTP_BODY == NONCE) y hashes SHA-256 de archivos clave.
//
//   bun run scripts/closure-baseline.ts
//
// Requiere: tunel del MCP corriendo para el exec nativo; una sesion en el
// registro (prefiere `codex-web-http-e2e-rw`, si no la primera disponible).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildChatGPTCommand } from "../src/mcp/identity";

const ROOT = join(import.meta.dir, "..");
const HOME = process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http");
const PORT = process.env.CLOSURE_PORT?.trim() || "8797";
const KEY_FILES = [
  "src/web-turn.ts",
  "src/chat-completions.ts",
  "src/server.ts",
  "src/mcp/main.ts",
  "src/codex-sessions.ts",
];

const sha = (rel: string): string =>
  createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex").slice(0, 16);

// 1) tests
const testProc = Bun.spawnSync(["bun", "test"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
const testOut = `${testProc.stdout.toString()}${testProc.stderr.toString()}`;
const match = testOut.match(/(\d+) pass\D+(\d+) fail/);
const tests = {
  pass: Number(match?.[1] ?? -1),
  fail: Number(match?.[2] ?? -1),
  exit: testProc.exitCode ?? 1,
};

// 2) E2E nonce por HTTP
const sessions = (JSON.parse(readFileSync(join(HOME, "codex-sessions.json"), "utf8")) as {
  sessions: Array<{ token: string; label: string; fp: string }>;
}).sessions;
const session = sessions.find((s) => s.label === "codex-web-http-e2e-rw") ?? sessions[0];
const nonce = `ISYMCP_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let e2e: { ok: boolean; reason: string; nonce: string; http: string } = {
  ok: false,
  reason: "sin sesion en el registro",
  nonce,
  http: "",
};
let server: ReturnType<typeof Bun.spawn> | undefined;
if (session) {
  server = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts")], {
    cwd: ROOT,
    env: { ...process.env, CODEX_WEB_HTTP_PORT: PORT, CODEX_WEB_HTTP_CONNECTOR: "Codex ISyMCP" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/health`);
        up = r.ok;
      } catch {
        /* arrancando */
      }
      if (!up) await Bun.sleep(500);
    }
    const content = buildChatGPTCommand(
      `Ejecuta con codex_exec ["echo","${nonce}"] y responde EXACTAMENTE la salida del comando.`,
      { turnToken: session.token },
    );
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", messages: [{ role: "user", content }] }),
    });
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown };
    const text = data.choices?.[0]?.message?.content ?? JSON.stringify(data.error ?? data);
    e2e = { ok: text.trim() === nonce, reason: text.trim() === nonce ? "ok" : "mismatch", nonce, http: text.slice(0, 160) };
  } catch (err) {
    e2e = { ok: false, reason: String(err).slice(0, 160), nonce, http: "" };
  } finally {
    server.kill();
    await server.exited;
  }
}

// 3) evidencia
const out = {
  ts: new Date().toISOString(),
  tests,
  e2e,
  hashes: Object.fromEntries(KEY_FILES.map((f) => [f, sha(f)])),
};
mkdirSync(join(ROOT, "docs", "evidence"), { recursive: true });
const outPath = join(ROOT, "docs", "evidence", `closure-${Date.now()}.json`);
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ tests, e2e_ok: e2e.ok, e2e_reason: e2e.reason, out: outPath }, null, 1));
process.exit(tests.fail === 0 && e2e.ok ? 0 : 1);
