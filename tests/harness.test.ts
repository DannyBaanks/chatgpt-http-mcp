// harness.test.ts — motor de harnesses + MCP isymcp-chatgpt, sin depender de
// que el host tenga claude/codex/... (CI): CLIs falsos en un PATH propio que
// imitan `mcp add/remove/list/get` guardando estado en un archivo, y un bridge
// falso para chatgpt_ask.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, CATALOG, detect, launcherPath, MCP_NAME, plan } from "../src/harness";
import { handleHarnessApi } from "../src/panel";
import { loadChat } from "../src/chats";
import { ROOT } from "./helpers/mcp-call";

let dir: string;
let bin: string;
let state: string;
const savedPath = process.env.PATH;

// CLI falso: registra cada invocacion y mantiene la lista de servidores MCP.
const FAKE = `#!/bin/sh
echo "$(basename "$0") $*" >> "$FAKE_LOG"
[ "$1" = "mcp" ] || exit 0
sub="$2"; shift 2
name=""; for a in "$@"; do case "$a" in ${MCP_NAME}) name="$a";; esac; done
st="$FAKE_STATE.$(basename "$0")"
case "$sub" in
  add) echo "$name" >> "$st"; echo "Added $name";;
  remove) [ -f "$st" ] && grep -v "^$name$" "$st" > "$st.tmp"; mv "$st.tmp" "$st" 2>/dev/null; echo "Removed $name";;
  list) [ -f "$st" ] && cat "$st"; echo "(fin)";;
  get) [ -f "$st" ] && grep -q "^$name$" "$st" && { echo "$name: stdio"; exit 0; }; echo "No MCP server found"; exit 1;;
esac
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "isymcp-harness-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  state = join(dir, "state");
  for (const name of ["claude", "codex", "qwen", "gemini", "grok", "kimi"]) {
    writeFileSync(join(bin, name), FAKE, { mode: 0o755 });
  }
  writeFileSync(join(bin, "noexec"), "#!/bin/sh\n", { mode: 0o644 });
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.FAKE_STATE = state;
  process.env.FAKE_LOG = join(dir, "log");
  process.env.CODEX_WEB_HTTP_HOME = join(dir, "home");
});
afterAll(() => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_STATE; delete process.env.FAKE_LOG; delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe("deteccion", () => {
  test("presente segun PATH; soportado solo con estrategia verificada; nada instalado al inicio", async () => {
    const all = await detect();
    expect(all.map((s) => s.id)).toEqual(CATALOG.map((d) => d.id));
    const by = Object.fromEntries(all.map((s) => [s.id, s]));
    for (const id of ["claude", "codex", "qwen", "gemini", "grok"]) expect(by[id]).toMatchObject({ present: true, supported: true, installed: false });
    expect(by.kimi).toMatchObject({ present: true, supported: false, installed: null });
    expect(by.opencode).toMatchObject({ present: false });
  });
});

describe("plan / apply / verify", () => {
  test("el plan no escribe nada y muestra el comando exacto", async () => {
    const before = existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8") : "";
    const steps = await plan("install", ["claude", "gemini", "kimi", "nope"]);
    expect(steps.find((s) => s.id === "claude")!.argv).toEqual([join(bin, "claude"), "mcp", "add", "--scope", "user", MCP_NAME, "--", launcherPath()]);
    expect(steps.find((s) => s.id === "gemini")!.argv).toContain("--scope");
    expect(steps.find((s) => s.id === "kimi")!.argv).toBeNull();
    expect(steps.find((s) => s.id === "nope")!.reason).toBe("harness desconocido");
    const after = readFileSync(process.env.FAKE_LOG!, "utf8").slice(before.length);
    expect(after).not.toContain(" mcp add ");
    expect(existsSync(launcherPath())).toBe(false);
  });

  test("apply exige aprobacion literal", async () => {
    await expect(apply("install", ["claude"], false)).rejects.toThrow(/aprobacion/);
    await expect(apply("install", ["claude"], "si" as unknown as boolean)).rejects.toThrow(/aprobacion/);
  });

  test("instala, verifica con la herramienta, es idempotente y se quita", async () => {
    const ids = ["claude", "codex", "qwen", "gemini", "grok"];
    const installed = await apply("install", ids, true);
    expect(installed.every((r) => r.ran && r.ok && r.verified === true)).toBe(true);
    expect(existsSync(launcherPath())).toBe(true);
    expect(readFileSync(launcherPath(), "utf8")).toContain("src/mcp/chatgpt.ts");
    expect((await detect(ids)).every((s) => s.installed === true)).toBe(true);
    // Segunda vez: nada que hacer.
    expect((await apply("install", ids, true)).every((r) => !r.ran)).toBe(true);
    const removed = await apply("uninstall", ids, true);
    expect(removed.every((r) => r.ran && r.ok && r.verified === true)).toBe(true);
    expect((await detect(ids)).every((s) => s.installed === false)).toBe(true);
  });
});

describe("API del panel", () => {
  const call = (path: string, body: unknown) => {
    const url = new URL(`http://127.0.0.1${path}`);
    return handleHarnessApi(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url);
  };
  test("aplicar sin confirm:true se rechaza; acciones invalidas tambien", async () => {
    expect((await call("/api/harness/apply", { action: "install", ids: ["claude"] })).status).toBe(400);
    expect((await call("/api/harness/apply", { action: "rm -rf", ids: ["claude"], confirm: true })).status).toBe(400);
    expect((await call("/api/harness/plan", { action: "install", ids: [] })).status).toBe(400);
    const ok = await call("/api/harness/apply", { action: "install", ids: ["grok"], confirm: true });
    expect(((await ok.json()) as { results: Array<{ verified: boolean }> }).results[0]!.verified).toBe(true);
    await call("/api/harness/apply", { action: "uninstall", ids: ["grok"], confirm: true });
  });
});

describe("MCP isymcp-chatgpt (bridge falso)", () => {
  async function ask(args: Record<string, unknown>, port: number): Promise<{ isError: boolean; text: string }> {
    const proc = Bun.spawn(["bun", "src/mcp/chatgpt.ts"], {
      cwd: ROOT, env: { ...process.env, PATH: savedPath, CODEX_WEB_HTTP_PORT: String(port) },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const send = (m: unknown) => { proc.stdin.write(`${JSON.stringify(m)}\n`); proc.stdin.flush(); };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chatgpt_ask", arguments: args } });
    const reader = proc.stdout.getReader();
    let buf = "";
    const t0 = Date.now();
    while (!buf.includes('"id":2') && Date.now() - t0 < 20_000) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    proc.kill();
    const result = JSON.parse(buf.split("\n").find((l) => l.includes('"id":2'))!).result;
    return { isError: Boolean(result.isError), text: result.content[0].text };
  }

  test("pregunta, devuelve thread_id, continua el hilo y clasifica errores", async () => {
    const received: Array<{ chat_id: string; message: string }> = [];
    const bridge = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const body = await req.json() as { chat_id: string; message: string };
        received.push(body);
        if (body.message === "bloquea") return Response.json({ ok: false, reply: { role: "error", text: "bloqueado", meta: { kind: "provider_blocked" } } });
        return Response.json({ ok: true, reply: { role: "assistant", text: `eco: ${body.message}`, meta: { url: "https://chatgpt.com/c/0000aaaa-1111-2222-3333-444455556666" } } });
      },
    });
    try {
      const first = await ask({ prompt: "hola" }, bridge.port);
      expect(first.isError).toBe(false);
      expect(first.text).toStartWith("eco: hola");
      const thread = /thread_id: (c_[0-9a-f]{16})/.exec(first.text)![1]!;
      // El chat queda en el registro del panel, titulado con el cliente.
      expect(loadChat(thread)!.title).toBe("[test-client] hola");
      const second = await ask({ prompt: "sigue", thread_id: thread }, bridge.port);
      expect(second.text).toContain(`thread_id: ${thread}`);
      expect(received.map((r) => r.chat_id)).toEqual([thread, thread]);
      const blocked = await ask({ prompt: "bloquea", thread_id: thread }, bridge.port);
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain("OpenAI bloqueo");
      const bad = await ask({ prompt: "x", thread_id: "../codex-sessions" }, bridge.port);
      expect(bad).toEqual({ isError: true, text: "thread_id desconocido: ../codex-sessions" });
    } finally {
      bridge.stop(true);
    }
    const down = await ask({ prompt: "hola" }, 1);
    expect(down.isError).toBe(true);
    expect(down.text).toContain("isymcp server start");
  }, 60_000);
});
