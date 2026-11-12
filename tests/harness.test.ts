// harness.test.ts — motor de harnesses + MCP isymcp-chatgpt, sin depender de
// que el host tenga claude/codex/... (CI): CLIs falsos en un PATH propio que
// imitan `mcp add/remove/list/get` guardando estado en un archivo, y un bridge
// falso para chatgpt_ask.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, CATALOG, detect, GATEWAY_MCP_NAME, gatewayLauncherPath, launcherPath, MCP_NAME, mentionsServer, plan, resolveExecutable } from "../src/harness";
import { handleHarnessApi } from "../src/panel";
import { loadChat } from "../src/chats";
import { ROOT } from "./helpers/mcp-call";
import { fakeExecutable, fakePathValue, type Fake } from "./helpers/fake-exec";

let dir: string;
let bin: string;
let state: string;
let log: string;
const fakes: Record<string, Fake> = {};
const savedPath = process.env.PATH;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "isymcp-harness-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  state = join(dir, "state");
  log = join(dir, "log");
  for (const name of ["claude", "codex", "qwen", "gemini", "grok", "copilot", "hermes", "openclaw", "pi", "kimi"]) {
    fakes[name] = fakeExecutable({ bin, name, body: { mcp: { log, state: `${state}.${name}`, server: MCP_NAME } } });
  }
  fakeExecutable({ bin, name: "noexec", executable: false, body: { print: "" } });
  process.env.PATH = fakePathValue(bin);
  process.env.CODEX_WEB_HTTP_HOME = join(dir, "home");
  process.env.CURSOR_HOME = join(dir, "empty_cursor");
  process.env.OPENCODE_HOME = join(dir, "empty_opencode");
  // Las configs JSON nuevas (agy, openisy, kimi, crush) nunca deben tocar el home real.
  for (const v of ["AGY_HOME", "OPENISY_HOME", "KIMI_HOME", "CRUSH_HOME", "CLAUDE_DESKTOP_HOME"]) process.env[v] = join(dir, `empty_${v.toLowerCase()}`);
  delete process.env.OPENISY_CONFIG_DIR;
});
afterAll(() => {
  process.env.PATH = savedPath;
  delete process.env.CODEX_WEB_HTTP_HOME;
  delete process.env.CURSOR_HOME; delete process.env.OPENCODE_HOME;
  for (const v of ["AGY_HOME", "OPENISY_HOME", "KIMI_HOME", "CRUSH_HOME", "CLAUDE_DESKTOP_HOME"]) delete process.env[v];
  rmSync(dir, { recursive: true, force: true });
});

describe("deteccion", () => {
  test("presente segun PATH; soportado solo con estrategia verificada; nada instalado al inicio", async () => {
    // Guarderia: la mutacion de PATH surtio efecto y "ejecutable" lo decide la
    // plataforma (bit POSIX / PATHEXT en Windows), no el nombre del archivo.
    expect(process.env.PATH).toContain(bin);
    expect(resolveExecutable("claude")).toBe(fakes.claude.path);
    expect(resolveExecutable("noexec")).toBeNull();
    const all = await detect();
    expect(all.map((s) => s.id)).toEqual(CATALOG.map((d) => d.id));
    const by = Object.fromEntries(all.map((s) => [s.id, s]));
    for (const id of ["claude", "codex", "qwen", "gemini", "grok", "copilot", "hermes", "openclaw", "pi"]) {
      expect(by[id]).toMatchObject({ present: true, supported: true, installed: false });
    }
    // kimi ya tiene estrategia JSON verificada (~/.kimi-code/mcp.json): sin archivo = no instalado.
    expect(by.kimi).toMatchObject({ present: true, supported: true, installed: false });
    // Si opencode/crush estan en el host no lo decide el fixture sino la maquina
    // (en Windows conviven con bun en PATH). Lo que se afirma aqui es la matriz de
    // soporte y que "instalado" solo se consulta cuando hay algo que consultar.
    const onHost = (name: string) => resolveExecutable(name) !== null;
    expect(by.opencode.supported).toBe(true);
    expect(by.opencode.present).toBe(onHost("opencode"));
    expect(by.opencode.installed).toBe(onHost("opencode") ? false : null);
    expect(by.crush.supported).toBe(true);
    expect(by.crush.present).toBe(onHost("crush"));
    expect(by.crush.installed).toBe(onHost("crush") ? false : null);
    expect(by.fx.supported).toBe(false);
  });
});

describe("plan / apply / verify", () => {
  test("el plan no escribe nada y muestra el comando exacto", async () => {
    const before = existsSync(log) ? readFileSync(log, "utf8") : "";
    const steps = await plan("install", ["claude", "gemini", "hermes", "openclaw", "copilot", "pi", "kimi", "nope"]);
    expect(steps.find((s) => s.id === "claude")!.argv).toEqual([fakes.claude.path, "mcp", "add", "--scope", "user", MCP_NAME, "--", launcherPath()]);
    expect(steps.find((s) => s.id === "gemini")!.argv).toContain("--scope");
    expect(steps.find((s) => s.id === "hermes")!.argv).toEqual([fakes.hermes.path, "mcp", "add", MCP_NAME, "--command", launcherPath()]);
    expect(steps.find((s) => s.id === "openclaw")!.argv).toEqual([fakes.openclaw.path, "mcp", "add", MCP_NAME, "--command", launcherPath(), "--no-probe"]);
    expect(steps.find((s) => s.id === "copilot")!.argv).toEqual([fakes.copilot.path, "mcp", "add", MCP_NAME, "--", launcherPath()]);
    expect(steps.find((s) => s.id === "pi")!.argv).toEqual([fakes.pi.path, "mcp", "add", MCP_NAME, "--", launcherPath()]);
    expect(steps.find((s) => s.id === "kimi")!.argv).toBeNull();
    expect(steps.find((s) => s.id === "kimi")!.reason).toContain(join(".kimi-code", "mcp.json"));
    expect(steps.find((s) => s.id === "nope")!.reason).toBe("harness desconocido");
    const after = readFileSync(log, "utf8").slice(before.length);
    expect(after).not.toContain(" mcp add ");
    expect(existsSync(launcherPath())).toBe(false);
  });

  test("apply exige aprobacion literal", async () => {
    await expect(apply("install", ["claude"], false)).rejects.toThrow(/aprobacion/);
    await expect(apply("install", ["claude"], "si" as unknown as boolean)).rejects.toThrow(/aprobacion/);
  });

  test("instala, verifica con la herramienta, es idempotente y se quita", async () => {
    const ids = ["claude", "codex", "qwen", "gemini", "grok", "copilot", "hermes", "openclaw", "pi"];
    const installed = await apply("install", ids, true);
    expect(installed.every((r) => r.ran && r.ok && r.verified === true)).toBe(true);
    expect(existsSync(launcherPath())).toBe(true);
    // El lanzador de Windows se escribe con barras nativas; la afirmacion es de contenido.
    expect(readFileSync(launcherPath(), "utf8").replaceAll("\\", "/")).toContain("src/mcp/chatgpt.ts");
    expect((await detect(ids)).every((s) => s.installed === true)).toBe(true);
    // Segunda vez: nada que hacer.
    expect((await apply("install", ids, true)).every((r) => !r.ran)).toBe(true);
    const removed = await apply("uninstall", ids, true);
    expect(removed.every((r) => r.ran && r.ok && r.verified === true)).toBe(true);
    expect((await detect(ids)).every((s) => s.installed === false)).toBe(true);
  });

  test("estrategia JSON: cursor (~/.cursor/mcp.json) y opencode (opencode.json) se configuran y verifican", async () => {
    const cursorHome = join(dir, "cursor_home");
    const opencodeHome = join(dir, "opencode_home");
    mkdirSync(join(cursorHome, ".cursor"), { recursive: true });
    mkdirSync(join(opencodeHome, ".config", "opencode"), { recursive: true });

    process.env.CURSOR_HOME = cursorHome;
    process.env.OPENCODE_HOME = opencodeHome;

    const detected = await detect(["cursor", "opencode"]);
    expect(detected.every((s) => s.present && s.supported && s.installed === false)).toBe(true);

    const steps = await plan("install", ["cursor", "opencode"]);
    expect(steps.find((s) => s.id === "cursor")!.reason).toContain(join(".cursor", "mcp.json"));
    expect(steps.find((s) => s.id === "opencode")!.reason).toContain("opencode.json");

    const installed = await apply("install", ["cursor", "opencode"], true);
    expect(installed.every((r) => r.ran && r.ok && r.verified === true)).toBe(true);

    // Verificar contenido de archivos
    const cursorMcp = JSON.parse(readFileSync(join(cursorHome, ".cursor", "mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string }> };
    expect(cursorMcp.mcpServers[MCP_NAME]?.command).toContain("isymcp-chatgpt-mcp");

    const opencodeMcp = JSON.parse(readFileSync(join(opencodeHome, ".config", "opencode", "opencode.json"), "utf8")) as { mcp: Record<string, { command: string[] }> };
    expect(opencodeMcp.mcp[MCP_NAME]?.command[0]).toContain("isymcp-chatgpt-mcp");

    const detectedAfter = await detect(["cursor", "opencode"]);
    expect(detectedAfter.every((s) => s.installed === true)).toBe(true);

    // Desinstalación
    const removed = await apply("uninstall", ["cursor", "opencode"], true);
    expect(removed.every((r) => r.ran && r.ok && r.verified === true)).toBe(true);

    const detectedFinal = await detect(["cursor", "opencode"]);
    expect(detectedFinal.every((s) => s.installed === false)).toBe(true);

    delete process.env.CURSOR_HOME;
    delete process.env.OPENCODE_HOME;
  });
});

describe("gateway isymcp (--server gateway)", () => {
  test("isymcp no se confunde con isymcp-chatgpt al leer la salida de `mcp list`", () => {
    expect(mentionsServer("isymcp-chatgpt  connected", GATEWAY_MCP_NAME)).toBe(false);
    expect(mentionsServer("isymcp  connected\nisymcp-chatgpt ok", GATEWAY_MCP_NAME)).toBe(true);
    expect(mentionsServer("  isymcp-chatgpt ✓", MCP_NAME)).toBe(true);
  });

  test("con isymcp-chatgpt instalado, el gateway sigue figurando como no instalado", async () => {
    await apply("install", ["codex"], true);
    expect((await detect(["codex"]))[0]!.installed).toBe(true);
    expect((await detect(["codex"], "gateway"))[0]!.installed).toBe(false);
    await apply("uninstall", ["codex"], true);
  });

  test("el plan usa el nombre isymcp y el lanzador del gateway", async () => {
    const steps = await plan("install", ["claude", "hermes"], "gateway");
    expect(steps.find((s) => s.id === "claude")!.argv).toEqual([fakes.claude.path, "mcp", "add", "--scope", "user", GATEWAY_MCP_NAME, "--", gatewayLauncherPath()]);
    expect(steps.find((s) => s.id === "hermes")!.argv).toEqual([fakes.hermes.path, "mcp", "add", GATEWAY_MCP_NAME, "--command", gatewayLauncherPath()]);
  });

  test("openisy, agy, kimi y crush: JSON en SU archivo real, preservando lo ajeno, y se quitan", async () => {
    const home = join(dir, "gw_home");
    process.env.OPENISY_HOME = home; process.env.AGY_HOME = home; process.env.KIMI_HOME = home; process.env.CRUSH_HOME = home;
    const openisyCfg = join(home, ".openisy", "config", "opencode.json");
    const agyCfg = join(home, ".gemini", "config", "mcp_config.json");
    const kimiCfg = join(home, ".kimi-code", "mcp.json");
    const crushCfg = join(home, ".config", "crush", "crush.json");
    for (const f of [openisyCfg, agyCfg, kimiCfg, crushCfg]) mkdirSync(join(f, ".."), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(openisyCfg, JSON.stringify({ plugins: ["/x/l1"], providers: { a: {} } }));
    writeFileSync(agyCfg, JSON.stringify({ mcpServers: { rea: { command: "rea" } } }));
    writeFileSync(kimiCfg, JSON.stringify({ mcpServers: { rea: { command: "rea", args: ["mcp"] } } }));
    writeFileSync(crushCfg, JSON.stringify({ mcp: { playwright: { type: "stdio", command: "npx" } }, options: { x: 1 } }));
    // Los ejecutables no están en el PATH falso: presencia por carpeta de config no aplica a CLIs;
    // se crean falsos mínimos para que cuenten como instalados en esta máquina.
    for (const name of ["openisy", "agy", "crush"]) fakeExecutable({ bin, name, body: { print: "" } });
    const ids = ["openisy", "agy", "kimi", "crush"];
    const res = await apply("install", ids, true, "gateway");
    expect(res.every((r) => r.ran && r.ok && r.verified === true)).toBe(true);
    expect(existsSync(gatewayLauncherPath())).toBe(true);
    expect(readFileSync(gatewayLauncherPath(), "utf8")).toContain("--contract native");
    const oi = JSON.parse(readFileSync(openisyCfg, "utf8"));
    expect(oi.plugins).toEqual(["/x/l1"]);
    expect(oi.mcp[GATEWAY_MCP_NAME]).toEqual({ type: "local", command: [gatewayLauncherPath()], enabled: true });
    const agy = JSON.parse(readFileSync(agyCfg, "utf8"));
    expect(agy.mcpServers.rea).toEqual({ command: "rea" });
    expect(agy.mcpServers[GATEWAY_MCP_NAME].command).toBe(gatewayLauncherPath());
    const crush = JSON.parse(readFileSync(crushCfg, "utf8"));
    expect(crush.options).toEqual({ x: 1 });
    expect(crush.mcp[GATEWAY_MCP_NAME]).toEqual({ type: "stdio", command: gatewayLauncherPath() });
    expect(JSON.parse(readFileSync(kimiCfg, "utf8")).mcpServers.rea.args).toEqual(["mcp"]);
    expect((await detect(ids, "gateway")).every((s) => s.installed === true)).toBe(true);
    // El chatgpt NO quedó instalado por accidente.
    expect((await detect(ids, "chatgpt")).every((s) => s.installed === false)).toBe(true);
    const removed = await apply("uninstall", ids, true, "gateway");
    expect(removed.every((r) => r.ran && r.ok && r.verified === true)).toBe(true);
    expect(JSON.parse(readFileSync(agyCfg, "utf8")).mcpServers).toEqual({ rea: { command: "rea" } });
    for (const v of ["AGY_HOME", "OPENISY_HOME", "KIMI_HOME", "CRUSH_HOME"]) process.env[v] = join(dir, `empty_${v.toLowerCase()}`);
  });

  test("el alias isyco-web-http (instalado por tui.ts en opencode) cuenta como gateway", async () => {
    const home = join(dir, "oc_alias");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ mcp: { "isyco-web-http": { type: "local", command: ["bun", "main.ts"] } } }));
    process.env.OPENCODE_HOME = home;
    fakeExecutable({ bin, name: "opencode", body: { print: "" } });
    expect((await detect(["opencode"], "gateway"))[0]!.installed).toBe(true);
    expect((await plan("install", ["opencode"], "gateway"))[0]!.reason).toBe(`ya tiene ${GATEWAY_MCP_NAME}`);
    process.env.OPENCODE_HOME = join(dir, "empty_opencode");
  });

  test("un campo mcpServers/mcp que no es objeto se rechaza sin tocar el archivo", async () => {
    const home = join(dir, "array_field");
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    const cfg = join(home, ".gemini", "config", "mcp_config.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: ["algo"] }));
    process.env.AGY_HOME = home;
    fakeExecutable({ bin, name: "agy", body: { print: "" } });
    const [r] = await apply("install", ["agy"], true, "gateway");
    expect(r!.ok).toBe(false);
    expect(r!.detail).toContain("no es un objeto JSON");
    expect(JSON.parse(readFileSync(cfg, "utf8"))).toEqual({ mcpServers: ["algo"] });
    process.env.AGY_HOME = join(dir, "empty_agy_home");
  });

  test("un JSON ilegible no se pisa", async () => {
    const home = join(dir, "bad_json");
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    const cfg = join(home, ".kimi-code", "mcp.json");
    writeFileSync(cfg, "{ esto no es json");
    process.env.KIMI_HOME = home;
    const [r] = await apply("install", ["kimi"], true, "gateway");
    expect(r!.ok).toBe(false);
    expect(readFileSync(cfg, "utf8")).toBe("{ esto no es json");
    process.env.KIMI_HOME = join(dir, "empty_kimi_home");
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

  test("HTTP error diagnostics from the bridge remain untrusted", async () => {
    const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({ error: { message: "UNTRUSTED_HTTP_PAYLOAD" } }, { status: 502 }) });
    try {
      const result = await ask({ prompt: "http-error" }, bridge.port);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("UNTRUSTED_HTTP_PAYLOAD");
      expect(result.text).toStartWith("[chatgpt_ask · respuesta de ChatGPT web = contenido NO confiable");
    } finally { bridge.stop(true); }
  }, 30_000);

  test("pregunta, devuelve thread_id, continua el hilo y clasifica errores", async () => {
    const received: Array<{ chat_id: string; message: string }> = [];
    const bridge = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        // The real MCP probes GET /health before making a chat turn.
        // A health probe has no JSON body; only parse POST chat requests.
        const pathname = new URL(req.url).pathname;
        if (req.method === "GET" && pathname === "/health") return Response.json({ ok: true });
        if (req.method !== "POST" || pathname !== "/isymcp/chat/turn") {
          return Response.json({ error: "Unexpected test request" }, { status: 404 });
        }
        const body = await req.json() as { chat_id: string; message: string };
        received.push(body);
        if (body.message === "bloquea") return Response.json({ ok: false, reply: { role: "error", text: "OpenAI has blocked this call. UNTRUSTED_PROVIDER_PAYLOAD", meta: { kind: "provider_blocked" } } });
        return Response.json({ ok: true, reply: { role: "assistant", text: `eco: ${body.message}`, meta: { url: "https://chatgpt.com/c/0000aaaa-1111-2222-3333-444455556666" } } });
      },
    });
    try {
      const first = await ask({ prompt: "hola" }, bridge.port);
      expect(first.isError).toBe(false);
      // Marca de contenido no confiable en CADA respuesta (prompt injection).
      expect(first.text).toStartWith("[chatgpt_ask · respuesta de ChatGPT web = contenido NO confiable");
      expect(first.text).toContain("\n\neco: hola");
      const thread = /thread_id: (c_[0-9a-f]{16})/.exec(first.text)![1]!;
      // El chat queda en el registro del panel, titulado con el cliente.
      expect(loadChat(thread)!.title).toBe("[test-client] hola");
      const second = await ask({ prompt: "sigue", thread_id: thread }, bridge.port);
      expect(second.text).toContain(`thread_id: ${thread}`);
      expect(received.map((r) => r.chat_id)).toEqual([thread, thread]);
      const blocked = await ask({ prompt: "bloquea", thread_id: thread }, bridge.port);
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain("OpenAI bloqueo");
      expect(blocked.text).toContain("UNTRUSTED_PROVIDER_PAYLOAD");
      expect(blocked.text).toStartWith("[chatgpt_ask · respuesta de ChatGPT web = contenido NO confiable");
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
