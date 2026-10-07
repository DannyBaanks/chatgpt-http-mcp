#!/usr/bin/env bun
// soak-tools.ts — N acciones DISTINTAS con tools reales via HTTP -> ChatGPT Web
// -> tunel -> MCP -> bwrap. Cada turno tiene un resultado verificable
// localmente (no "el modelo dijo OK"), y ademas se cruza con mcp-trace.log:
// la tool esperada tiene que aparecer llamada con el fingerprint de la sesion
// del soak durante ese turno. Si el modelo contesta bien sin llamar la tool,
// el turno FALLA.
//
//   bun run scripts/soak-tools.ts [PORT]
//
// Usa una sesion rw propia (ttl 2h) sobre un workspace desechable bajo
// .test-tmp/ y la revoca al terminar. Evidencia: docs/evidence/soak-tools-<ts>.json
import { createHash } from "node:crypto";
import { mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildChatGPTCommand } from "../src/mcp/identity";
import { fingerprint, mintSession, revokeSession } from "../src/codex-sessions";

const ROOT = join(import.meta.dir, "..");
const BRIDGE = process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http");
const TRACE = join(BRIDGE, "mcp-trace.log");
const PORT = process.argv[2] ?? "8796";
const MODEL = process.env.SOAK_MODEL ?? "chatgpt-web/gpt-5.6-sol";
const nonce = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

// --- workspace desechable -------------------------------------------------
const ws = join(ROOT, ".test-tmp", `soak-tools-${Date.now()}`);
mkdirSync(ws, { recursive: true });
const sh = (cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd: ws, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};
const N_CAT = nonce();
const N_LS = nonce();
const N_GIT = nonce();
const N_ECHO = nonce();
const N_SHA = nonce();
const N_PATCH = nonce();
writeFileSync(join(ws, "nota.txt"), `${N_CAT}\n`);
writeFileSync(join(ws, `marca-${N_LS}.dat`), "x");
writeFileSync(join(ws, "lineas.txt"), Array.from({ length: 37 }, (_, i) => `linea ${i + 1}`).join("\n") + "\n");
// PNG 1x1 valido.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
writeFileSync(join(ws, "punto.png"), png);
sh(["git", "init", "-q"]);
sh(["git", "-c", "user.name=soak", "-c", "user.email=soak@local", "add", "-A"]);
sh(["git", "-c", "user.name=soak", "-c", "user.email=soak@local", "commit", "-q", "-m", `soak ${N_GIT}`]);
const bunVersion = Bun.spawnSync(["bun", "--version"]).stdout.toString().trim();

const session = mintSession(ws, { label: "soak-tools", writable: true, ttlHours: 2 });
const fp = fingerprint(session.token);

// --- casos ------------------------------------------------------------------
interface Case {
  name: string;
  tool: string;
  task: string;
  check: (reply: string) => boolean;
  expected: string;
}
const exact = (want: string) => (reply: string) => reply.trim().replace(/^`+|`+$/g, "").trim() === want;
const cases: Case[] = [
  { name: "echo", tool: "codex_exec", expected: N_ECHO, check: exact(N_ECHO),
    task: `Ejecuta con codex_exec ["echo","${N_ECHO}"] y responde EXACTAMENTE la salida del comando, sin nada mas.` },
  { name: "cat", tool: "codex_exec", expected: N_CAT, check: exact(N_CAT),
    task: `Ejecuta con codex_exec ["cat","nota.txt"] y responde EXACTAMENTE el contenido del archivo, sin nada mas.` },
  { name: "sha256-pipe", tool: "codex_exec",
    expected: createHash("sha256").update(N_SHA).digest("hex").slice(0, 16),
    check: exact(createHash("sha256").update(N_SHA).digest("hex").slice(0, 16)),
    task: `Ejecuta con codex_exec ["sh","-c","printf %s ${N_SHA} | sha256sum | cut -c1-16"] y responde EXACTAMENTE la salida, sin nada mas.` },
  { name: "ls", tool: "codex_exec", expected: `marca-${N_LS}.dat`, check: exact(`marca-${N_LS}.dat`),
    task: `Ejecuta con codex_exec ["ls"] y responde EXACTAMENTE el nombre del unico archivo que empieza con "marca-", sin nada mas.` },
  { name: "wc", tool: "codex_exec", expected: "37", check: exact("37"),
    task: `Ejecuta con codex_exec ["sh","-c","wc -l < lineas.txt"] y responde EXACTAMENTE el numero, sin nada mas.` },
  { name: "git-log", tool: "codex_exec", expected: `soak ${N_GIT}`, check: exact(`soak ${N_GIT}`),
    task: `Ejecuta con codex_exec ["git","log","-1","--format=%s"] y responde EXACTAMENTE la salida, sin nada mas.` },
  { name: "toolchain-bun", tool: "codex_exec", expected: bunVersion, check: exact(bunVersion),
    task: `Ejecuta con codex_exec ["bun","--version"] y responde EXACTAMENTE la salida, sin nada mas.` },
  { name: "apply-patch", tool: "codex_apply_patch", expected: `archivo patch-${N_PATCH}.txt creado`,
    check: () => existsSync(join(ws, `patch-${N_PATCH}.txt`))
      && readFileSync(join(ws, `patch-${N_PATCH}.txt`), "utf8").trim() === N_PATCH,
    task: [
      "Usa codex_apply_patch con EXACTAMENTE este patch (diff unificado) y despues responde solo OK:",
      `--- /dev/null`,
      `+++ b/patch-${N_PATCH}.txt`,
      `@@ -0,0 +1 @@`,
      `+${N_PATCH}`,
    ].join("\n") },
  { name: "view-image", tool: "codex_view_image", expected: String(png.length), check: exact(String(png.length)),
    task: `Usa codex_view_image con path "punto.png" y responde EXACTAMENTE el valor del campo "bytes" del resultado, sin nada mas.` },
  { name: "tool-inventory", tool: "codex_tool_inventory", expected: "6", check: exact("6"),
    task: `Usa codex_tool_inventory y responde EXACTAMENTE cuantos elementos tiene la lista "tools", solo el numero.` },
];

// --- traza ------------------------------------------------------------------
const traceSize = () => (existsSync(TRACE) ? statSync(TRACE).size : 0);
function toolsCalledSince(offset: number): string[] {
  if (!existsSync(TRACE)) return [];
  const text = readFileSync(TRACE, "utf8").slice(offset);
  const tools: string[] = [];
  for (const line of text.split("\n")) {
    const m = / call (\{.*\})$/.exec(line);
    if (!m) continue;
    try {
      const d = JSON.parse(m[1]) as { tool?: string; token_fp?: string };
      if (d.token_fp === fp && d.tool) tools.push(d.tool);
    } catch { /* linea rota */ }
  }
  return tools;
}

// --- server -----------------------------------------------------------------
mkdirSync(join(BRIDGE, "run"), { recursive: true });
const server = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts")], {
  cwd: ROOT,
  env: { ...process.env, CODEX_WEB_HTTP_PORT: PORT, CODEX_WEB_HTTP_CONNECTOR: "Codex ISyMCP" },
  stdin: "ignore", stdout: "ignore",
  stderr: openSync(join(BRIDGE, "run", "soak-tools-server.log"), "a"),
});

interface Result { i: number; name: string; tool: string; ok: boolean; replyOk: boolean; toolCalled: boolean;
  toolsSeen: string[]; replayed: string | null; ms: number; expected: string; reply: string }
const results: Result[] = [];
const t0 = Date.now();
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* arrancando */ } await Bun.sleep(500); }
  for (const [index, c] of cases.entries()) {
    const i = index + 1;
    const turnId = `soak-tools-${i}-${nonce()}`;
    const content = buildChatGPTCommand(c.task, { turnToken: session.token });
    const body = JSON.stringify({ model: MODEL, messages: [{ role: "user", content }] });
    const offset = traceSize();
    const started = Date.now();
    let reply = ""; let replayed: string | null = null;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", "x-isymcp-turn-id": turnId }, body,
      });
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown };
      reply = data.choices?.[0]?.message?.content ?? `HTTP ${res.status} ${JSON.stringify(data.error ?? data).slice(0, 160)}`;
      // Replay idempotente: misma respuesta sin re-ejecutar (no debe sumar llamadas a la traza).
      const res2 = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", "x-isymcp-turn-id": turnId }, body,
      });
      replayed = res2.headers.get("x-isymcp-replayed");
    } catch (err) { reply = String(err).slice(0, 160); }
    await Bun.sleep(500); // la traza se escribe async
    const toolsSeen = toolsCalledSince(offset);
    const replyOk = c.check(reply);
    const toolCalled = toolsSeen.includes(c.tool);
    const ok = replyOk && toolCalled && replayed === "1";
    results.push({ i, name: c.name, tool: c.tool, ok, replyOk, toolCalled, toolsSeen, replayed,
      ms: Date.now() - started, expected: c.expected, reply: reply.slice(0, 200) });
    console.log(`[soak-tools ${i}/${cases.length}] ${c.name.padEnd(14)} ok=${ok} reply=${replyOk} tool=${toolCalled}(${toolsSeen.join(",") || "-"}) replay=${replayed} ms=${Date.now() - started}`);
    if (!replyOk) console.log(`    esperado=${JSON.stringify(c.expected)} recibido=${JSON.stringify(reply.slice(0, 160))}`);
  }
} finally {
  server.kill();
  await server.exited;
  revokeSession(session.fp);
}
const summary = {
  ts: new Date().toISOString(), model: MODEL, session_fp: fp, n: cases.length,
  ok: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length,
  totalMs: Date.now() - t0, results,
};
mkdirSync(join(ROOT, "docs", "evidence"), { recursive: true });
const out = join(ROOT, "docs", "evidence", `soak-tools-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(summary, null, 2));
rmSync(ws, { recursive: true, force: true });
console.log(JSON.stringify({ ok: summary.ok, fail: summary.fail, out }));
process.exit(summary.fail === 0 ? 0 : 1);
