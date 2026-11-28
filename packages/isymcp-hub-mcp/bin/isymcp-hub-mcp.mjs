#!/usr/bin/env node
// isymcp-hub-mcp — conector stdio ⇄ hub ISyMCP, en Node, sin dependencias.
//
// Es lo que se registra como MCP en un cliente (AutoClaw: `npx -y isymcp-hub-mcp`;
// Claude Code / Codex / AGY: command=npx args=[-y,isymcp-hub-mcp]). Hace EXACTAMENTE lo mismo
// que el conector Zig (`isymcp-hub connect`, hub/src/connect.zig): copia bytes entre su
// stdin/stdout y el socket Unix del daemon, sin parsear nada. Si el daemon no está, lo levanta
// desacoplado y espera a que escuche. No implementa tools: las 4 (hub_discover, hub_describe,
// hub_execute, agentspipeline) y los MCP detrás siguen siendo del daemon. Si no hay socket ni
// binario, falla con instrucciones: nunca inventa un hub paralelo.
//
//   isymcp-hub-mcp                 modo MCP (stdio)
//   isymcp-hub-mcp --status        JSON: socket, binario, versión del hub, MCP detrás
//   isymcp-hub-mcp --doctor        qué falta, en texto (rc 0 si el hub responde)
//
// Entorno (mismos nombres que el hub):
//   ISYMCP_HUB_SOCKET            ruta del socket (def: $XDG_RUNTIME_DIR/isymcp/hub.sock, o /run/user/<uid>/…)
//   ISYMCP_HUB_BIN               binario isymcp-hub para el autostart (def: ~/.codex-web-http/bin/isymcp-hub,
//                                ~/.local/bin/isymcp-hub, <repo>/hub/zig-out/bin/isymcp-hub)
//   ISYMCP_HUB_NO_AUTOSTART=1    no levantar el daemon (sólo conectar)
//   ISYMCP_HUB_CONNECT_WAIT_MS   ms de espera del autostart (def: 20000)
//   CODEX_WEB_HTTP_HOME          home del bridge (def: ~/.codex-web-http)
//   ISYMCP_HUB_LOG               log del autostart (def: <home>/hub/hub.autostart.log)
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// realpath: el bin puede correr por un symlink (node_modules/.bin, ~/.local/bin, npx) y
// createRequire sobre la ruta del symlink NO encuentra ../package.json.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const PKG = createRequire(SELF)("../package.json");
const VERSION = PKG.version;

// ----------------------------------------------------------------------------- rutas (espejo de src/hub/paths.ts)
function home() {
  return (process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http"));
}
export function socketPath(env = process.env) {
  if (env.ISYMCP_HUB_SOCKET?.trim()) return env.ISYMCP_HUB_SOCKET.trim();
  let runtime = env.XDG_RUNTIME_DIR?.trim();
  if (!(runtime && runtime.startsWith("/")) && typeof process.getuid === "function" && existsSync(`/run/user/${process.getuid()}`)) {
    runtime = `/run/user/${process.getuid()}`;
  }
  const dir = runtime && runtime.startsWith("/") ? join(runtime, "isymcp") : join(home(), "hub", "run");
  return join(dir, "hub.sock");
}
export function binaryCandidates(env = process.env) {
  const h = homedir();
  const out = [];
  if (env.ISYMCP_HUB_BIN?.trim()) out.push(env.ISYMCP_HUB_BIN.trim());
  out.push(join(home(), "bin", "isymcp-hub"));
  out.push(join(h, ".local", "bin", "isymcp-hub"));
  // instalado desde el repo (worktree/monorepo): packages/isymcp-hub-mcp → ../../hub/zig-out/bin
  try {
    const here = new URL("../../../../hub/zig-out/bin/isymcp-hub", import.meta.url);
    out.push(decodeURIComponent(here.pathname));
  } catch { /* noop */ }
  return out;
}
export function findBinary(env = process.env) {
  for (const p of binaryCandidates(env)) {
    try { if (existsSync(p)) return p; } catch { /* noop */ }
  }
  return null;
}
export function logPath(env = process.env) {
  return env.ISYMCP_HUB_LOG?.trim() || join(home(), "hub", "hub.autostart.log");
}

// ----------------------------------------------------------------------------- autostart (espejo de connect.zig:startDaemon)
function startDaemon(bin, env = process.env) {
  try {
    mkdirSync(dirname(logPath(env)), { recursive: true });
    const out = openSync(logPath(env), "a", 0o600);
    const child = spawn(bin, ["serve", "--quiet"], {
      detached: true, stdio: ["ignore", out, out], env: { ...env },
    });
    child.on("error", () => { /* el error real lo verá el wait */ });
    child.unref();
    closeSync(out);
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------- conectar
export async function connectHub(opts = {}) {
  const env = opts.env ?? process.env;
  const path = socketPath(env);
  const autostart = opts.autostart ?? env.ISYMCP_HUB_NO_AUTOSTART !== "1";
  const waitMs = opts.waitMs ?? (Number(env.ISYMCP_HUB_CONNECT_WAIT_MS) || 20_000);
  const tryOnce = () => new Promise((resolve) => {
    const s = createConnection(path);
    s.once("connect", () => resolve(s));
    s.once("error", () => resolve(null));
  });
  let sock = await tryOnce();
  if (sock) return sock;
  if (!autostart || waitMs <= 0) throw new Error(`hub no responde en ${path} (autostart desactivado)`);
  const bin = findBinary(env);
  if (!bin) {
    throw new Error(
      `hub no responde en ${path} y no hay binario isymcp-hub para arrancarlo.
  Instala el hub (una vez, en la máquina):
    cd <repo>/chatgpt-http-mcp && isymcp hub install --enable      # compila + systemd --user
    o sólo compila:  cd hub && zig build -Doptimize=ReleaseSafe    # Zig 0.16
  o apunta ISYMCP_HUB_BIN al binario / ISYMCP_HUB_SOCKET al socket si están en otra ruta.`);
  }
  if (!startDaemon(bin, env)) throw new Error(`hub no responde en ${path} y no se pudo arrancar ${bin} (mira ${logPath(env)})`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    sock = await tryOnce();
    if (sock) return sock;
  }
  throw new Error(`hub arrancado (${bin}) pero no escuchó en ${path} en ${waitMs} ms (mira ${logPath(env)})`);
}

// ----------------------------------------------------------------------------- pipe byte a byte (espejo de connect.run)
export async function runMcp() {
  let sock;
  try {
    sock = await connectHub();
  } catch (e) {
    process.stderr.write(`isymcp-hub-mcp: ${e.message}\n`);
    return 1;
  }
  let stdinOpen = true;
  process.stdin.on("end", () => { stdinOpen = false; sock.end(); });
  process.stdin.on("data", (chunk) => { if (!sock.write(chunk)) process.stdin.pause(); });
  sock.on("drain", () => { if (stdinOpen) process.stdin.resume(); });
  sock.on("data", (chunk) => { if (!process.stdout.write(chunk)) sock.pause(); });
  process.stdout.on("drain", () => sock.resume());
  sock.on("close", () => process.exit(0));
  sock.on("error", (err) => { process.stderr.write(`isymcp-hub-mcp: socket: ${err.message}\n`); process.exit(1); });
  process.stdin.resume();
  return new Promise(() => { /* termina por 'close' */ });
}

// ----------------------------------------------------------------------------- diagnóstico: --status / --doctor
async function rpc(sock, id, method, params) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      sock.off("data", onData);
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
    };
    sock.on("data", onData);
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { sock.off("data", onData); reject(new Error(`timeout en ${method}`)); }, 10_000).unref?.();
  });
}

export async function status() {
  const path = socketPath();
  const bin = findBinary();
  const out = {
    connector: "isymcp-hub-mcp", version: VERSION, socket: path, socket_exists: existsSync(path), binary: bin,
  };
  let sock;
  try {
    sock = await connectHub({ autostart: false });
  } catch (e) {
    out.hub = "down";
    out.error = e.message;
    return out;
  }
  try {
    const init = await rpc(sock, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "isymcp-hub-mcp", version: VERSION } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    out.hub = init.result?.serverInfo ?? null;
    const tl = await rpc(sock, 2, "tools/list", {});
    out.tools = (tl.result?.tools ?? []).map((t) => t.name);
    const st = await rpc(sock, 3, "tools/call", { name: "hub_discover", arguments: { detail: "status" } });
    const servers = st.result?.structuredContent?.servers ?? [];
    out.servers = servers.map((s) => ({ server: s.server, state: s.state, tools: s.tools }));
  } catch (e) {
    out.error = e.message;
  } finally {
    sock.end();
  }
  return out;
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--status" || arg === "status") {
    process.stdout.write(JSON.stringify(await status(), null, 2) + "\n");
    return 0;
  }
  if (arg === "--doctor" || arg === "doctor") {
    const s = await status();
    console.log(`isymcp-hub-mcp ${VERSION}`);
    console.log(`  socket  : ${s.socket} ${s.socket_exists ? "(existe)" : "(no existe)"}`);
    console.log(`  binario : ${s.binary ?? "(no encontrado)"}`);
    if (s.hub === "down") {
      console.log(`  hub     : NO RESPONDE — ${s.error}`);
      console.log("  arreglo : isymcp hub install --enable   (o) cd hub && zig build -Doptimize=ReleaseSafe");
      return 1;
    }
    console.log(`  hub     : ${JSON.stringify(s.hub)}`);
    console.log(`  tools   : ${s.tools.join(", ")}`);
    const servers = s.servers ?? [];
    console.log(`  MCPs    : ${servers.length} detrás del hub (${servers.filter((x) => x.state === "ready").length} listos)`);
    for (const x of servers) console.log(`    ${x.state === "ready" ? "●" : x.state === "direct" ? "→" : "○"} ${x.server.padEnd(22)} ${String(x.state).padEnd(10)} ${x.tools} tools`);
    if (s.error) console.log(`  nota    : ${s.error}`);
    return 0;
  }
  return runMcp();
}

// Comparar rutas REALES: el bin corre por symlink (node_modules/.bin, ~/.local/bin, npx) y ahí
// import.meta.url ya resuelve, pero process.argv[1] es la ruta del symlink.
const invoked = (() => {
  if (!process.argv[1]) return false;
  try { return SELF === realpathSync(process.argv[1]); } catch { return false; }
})();
if (invoked) {
  main().then((rc) => process.exit(rc)).catch((e) => { process.stderr.write(`isymcp-hub-mcp: ${e.stack ?? e}\n`); process.exit(1); });
}
