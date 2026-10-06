// mcp-session.test.ts — prueba viva del MCP stdio con session tokens.
//
// Spawnea `bun src/mcp/main.ts --contract native` (como lo hace el tunel),
// mintea sesiones sinteticas en un CODEX_WEB_HTTP_HOME temporal y verifica:
//   - codex_exec ejecuta de verdad dentro del workspace,
//   - read-only no puede escribir (bwrap ro),
//   - writable si puede (bwrap + bind del workspace).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mintSession } from "../src/codex-sessions";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let home: string;
let workspace: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "isyco-mcp-home-"));
  workspace = mkdtempSync(join(tmpdir(), "isyco-mcp-ws-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
});

afterAll(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

async function callTool(
  tool: string,
  args: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["bun", "src/mcp/main.ts", "--contract", "native"], {
    cwd: ROOT,
    env: { ...process.env, CODEX_WEB_HTTP_HOME: home, ...extraEnv },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (message: Record<string, unknown>) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bun-test", version: "0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });

  // Sin Promise.race por iteracion: filtraria un read() pendiente y con
  // respuestas lentas el dato resuelve el read filtrado (visto 2026-10-06).
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const readUntil = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('"id":2')) return;
    }
  })();
  await Promise.race([readUntil, new Promise((resolve) => setTimeout(resolve, 30_000))]);
  proc.kill();
  await proc.exited;

  const line = buf.split("\n").find((l) => l.includes('"id":2'));
  if (!line) throw new Error(`sin respuesta tools/call. stdout=${buf.slice(0, 500)}`);
  const message = JSON.parse(line) as { result?: { content?: Array<{ type: string; text?: string }> } };
  const text = message.result?.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error(`respuesta sin texto: ${line.slice(0, 500)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("MCP con session tokens (vivo)", () => {
  test("token desconocido conserva el stub de compat", async () => {
    const payload = await callTool("codex_exec", {
      turn_token: "token-desconocido-de-mas-de-veinte-chars",
      command: ["true"],
    });
    expect(payload.executed).toBe(false);
    expect(String(payload.stderr)).toContain("V1 stub");
  });

  test("read-only ejecuta y NO puede escribir", async () => {
    const session = mintSession(workspace, { label: "ro", writable: false });
    const ok = await callTool("codex_exec", {
      turn_token: session.token,
      command: ["sh", "-c", "echo hola; pwd"],
    });
    expect(ok.executed).toBe(true);
    expect(String(ok.stdout)).toContain("hola");
    expect(String(ok.stdout)).toContain(workspace);
    expect(ok.sandbox).toBe("bwrap-read-only");
    expect(ok.session).toMatchObject({ fp: session.fp, writable: false });

    const pwn = join(workspace, "pwn.txt");
    const denied = await callTool("codex_exec", {
      turn_token: session.token,
      command: ["sh", "-c", "echo pwn > pwn.txt"],
    });
    expect(denied.executed).toBe(true);
    expect(denied.exit_code).not.toBe(0);
    expect(existsSync(pwn)).toBe(false);
  });

  test("apply_patch: writable aplica, rechaza escape y read-only", async () => {
    const repo = mkdtempSync(join(tmpdir(), "isyco-mcp-repo-"));
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
      writeFileSync(join(repo, "nota.txt"), "hola\n");
      Bun.spawnSync(["git", "add", "nota.txt"], { cwd: repo });
      const patch = [
        "--- a/nota.txt",
        "+++ b/nota.txt",
        "@@ -1 +1,2 @@",
        " hola",
        "+mundo ISYMCP",
      ].join("\n");

      const rw = mintSession(repo, { label: "patch-rw", writable: true });
      const ok = await callTool("codex_apply_patch", { turn_token: rw.token, patch });
      expect(ok.executed).toBe(true);
      expect(String(ok.stderr)).toBe("");
      expect(readFileSync(join(repo, "nota.txt"), "utf8")).toContain("mundo ISYMCP");

      const escape = await callTool("codex_apply_patch", {
        turn_token: rw.token,
        patch: ["--- a/../fuera.txt", "+++ b/../fuera.txt", "@@ -0,0 +1 @@", "+x"].join("\n"),
      });
      expect(String(escape.error)).toContain("fuera del workspace");
      expect(existsSync(join(repo, "..", "fuera.txt"))).toBe(false);

      const ro = mintSession(repo, { label: "patch-ro", writable: false });
      const denied = await callTool("codex_apply_patch", { turn_token: ro.token, patch });
      expect(String(denied.error)).toContain("read-only");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("sandbox off: read-only falla cerrado, writable ejecuta sin sandbox", async () => {
    const ro = mintSession(workspace, { label: "nosandbox-ro", writable: false });
    const denied = await callTool(
      "codex_exec",
      { turn_token: ro.token, command: ["echo", "x"] },
      { CODEX_WEB_HTTP_SANDBOX: "off" },
    );
    expect(String(denied.error)).toContain("fail-closed");

    const rw = mintSession(workspace, { label: "nosandbox-rw", writable: true });
    const ok = await callTool(
      "codex_exec",
      { turn_token: rw.token, command: ["echo", "sin-sandbox"] },
      { CODEX_WEB_HTTP_SANDBOX: "off" },
    );
    expect(ok.executed).toBe(true);
    expect(ok.sandbox).toBe("none");
    expect(String(ok.stdout)).toContain("sin-sandbox");
  });

  test("timeout de exec: kill + timed_out", async () => {
    const rw = mintSession(workspace, { label: "timeout-rw", writable: true });
    const res = await callTool(
      "codex_exec",
      { turn_token: rw.token, command: ["sh", "-c", "sleep 5"] },
      { CODEX_WEB_HTTP_EXEC_TIMEOUT_MS: "800" },
    );
    expect(res.executed).toBe(true);
    expect(res.timed_out).toBe(true);
  }, 20_000);

  test("writable escribe solo dentro del workspace", async () => {
    const session = mintSession(workspace, { label: "rw", writable: true });
    const ok = await callTool("codex_exec", {
      turn_token: session.token,
      command: ["sh", "-c", "echo dato > dentro.txt && cat dentro.txt"],
    });
    expect(ok.executed).toBe(true);
    expect(ok.exit_code).toBe(0);
    expect(existsSync(join(workspace, "dentro.txt"))).toBe(true);

    const escape = await callTool("codex_exec", {
      turn_token: session.token,
      command: ["sh", "-c", "echo x > /tmp/isyco-escape.txt"],
    });
    // /tmp es tmpfs: escribir ahi no toca el disco real (queda en la burbuja).
    expect(escape.executed).toBe(true);
    expect(existsSync("/tmp/isyco-escape.txt")).toBe(false);

    const outside = await callTool("codex_exec", {
      turn_token: session.token,
      command: ["sh", "-c", "echo x > fuera.txt"],
      cwd: "../",
    });
    expect(String(outside.error)).toContain("fuera del workspace");
  });
});
