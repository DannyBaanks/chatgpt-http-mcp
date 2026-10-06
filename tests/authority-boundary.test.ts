// M4 del plan de cierre (P0): boundary de autoridad.
// La autoridad viene SOLO del session token valido en el registro; la URL, un
// contexto local presente o un token de otra sesion NO conceden ejecucion.
// Cada DENY se verifica ademas por ausencia de mutacion observable.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mintSession, revokeSession } from "../src/codex-sessions";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let home: string;
let wsA: string;
let wsB: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "isyco-auth-home-"));
  wsA = mkdtempSync(join(tmpdir(), "isyco-auth-a-"));
  wsB = mkdtempSync(join(tmpdir(), "isyco-auth-b-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
});

afterAll(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(wsA, { recursive: true, force: true });
  rmSync(wsB, { recursive: true, force: true });
});

async function callTool(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["bun", "src/mcp/main.ts", "--contract", "native"], {
    cwd: ROOT,
    env: { ...process.env, CODEX_WEB_HTTP_HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (message: Record<string, unknown>) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "auth-test", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
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
  if (!line) throw new Error(`sin respuesta tools/call: ${buf.slice(0, 300)}`);
  const message = JSON.parse(line) as { result?: { content?: Array<{ type: string; text?: string }> } };
  const text = message.result?.content?.find((c) => c.type === "text")?.text;
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

describe("M4: boundary de autoridad (vivo)", () => {
  test("token falso con contexto local presente: NO ejecuta y no muta", async () => {
    const contextFile = join(wsA, "context.txt");
    writeFileSync(contextFile, "contexto local presente (no autoriza)\n");
    const target = join(wsA, "pwn-by-fake.txt");
    const payload = await callTool("codex_exec", {
      turn_token: "token-falso-pero-largo-suficiente-1234567890",
      command: ["touch", target],
    });
    expect(payload.executed).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(contextFile)).toBe(true); // el contexto no se destruye ni autoriza
  });

  test("token de otra sesion: DENY cruzado, cero mutacion en el workspace ajeno", async () => {
    const a = mintSession(wsA, { label: "auth-a", writable: true });
    const b = mintSession(wsB, { label: "auth-b", writable: true });
    const targetA = join(wsA, "tocado-por-b.txt");
    const cross = await callTool("codex_exec", {
      turn_token: b.token,
      command: ["touch", targetA],
      cwd: wsA,
    });
    expect(String(cross.error)).toContain("fuera del workspace");
    expect(existsSync(targetA)).toBe(false);

    // control positivo: el token correcto sí ejecuta en SU workspace
    const own = await callTool("codex_exec", {
      turn_token: a.token,
      command: ["touch", join(wsA, "tocado-por-a.txt")],
    });
    expect(own.executed).toBe(true);
    expect(existsSync(join(wsA, "tocado-por-a.txt"))).toBe(true);
  });

  test("token revocado: DENY (sin ejecucion) aunque el registro exista", async () => {
    const c = mintSession(wsB, { label: "auth-c", writable: true });
    expect(revokeSession(c.fp)).toBe(1);
    const target = join(wsB, "pwn-revocado.txt");
    const payload = await callTool("codex_exec", {
      turn_token: c.token,
      command: ["touch", target],
    });
    expect(payload.executed).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  test("parametros extra (p.ej. url de conversacion) no participan de la autoridad", async () => {
    const d = mintSession(wsB, { label: "auth-d", writable: true });
    const target = join(wsB, "con-url-extra.txt");
    const withUrl = await callTool("codex_exec", {
      turn_token: d.token,
      command: ["touch", target],
      url: "https://chatgpt.com/c/otra-conversacion",
    });
    expect(withUrl.executed).toBe(true); // autoridad = token valido; la URL ni autoriza ni bloquea
    expect(existsSync(target)).toBe(true);
  });
});
