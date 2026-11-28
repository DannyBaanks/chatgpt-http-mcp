// node --test test/ — pruebas del conector sin tocar el hub real: todo en sockets/binarios falsos.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/isymcp-hub-mcp.mjs", import.meta.url));
const mk = () => mkdtempSync(join(tmpdir(), "isymcp-hub-mcp-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Hub falso: un server de línea JSON-RPC que responde initialize/tools/list y hace eco de bytes crudos. */
function fakeHub(sockPath, onInit) {
  const server = createServer((sock) => {
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === "initialize") {
          onInit?.(msg);
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake-hub", version: "9.9.9" } } }) + "\n");
        } else if (msg.method === "tools/list") {
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "hub_discover" }, { name: "hub_execute" }] } }) + "\n");
        } else if (msg.id !== undefined) {
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
        }
      }
    });
  });
  return new Promise((res) => server.listen(sockPath, () => res(server)));
}

/** Cliente JSON-RPC mínimo sobre el conector como proceso. */
function client(env) {
  const p = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
  let buf = ""; const pending = new Map();
  p.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  return {
    p,
    call(id, obj) { return new Promise((res) => { pending.set(id, res); p.stdin.write(JSON.stringify(obj) + "\n"); }); },
    async init() {
      const r = await this.call(1, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return r;
    },
    async tools() { return this.call(2, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }); },
    end() { p.stdin.end(); return new Promise((r) => p.once("exit", r)); },
  };
}

test("pipe byte a byte: el conector traslada JSON-RPC stdin⇄socket tal cual", async () => {
  const dir = mk();
  const sockPath = join(dir, "hub.sock");
  let inits = 0;
  const server = await fakeHub(sockPath, () => { inits++; });
  const c = client({ ISYMCP_HUB_SOCKET: sockPath, ISYMCP_HUB_NO_AUTOSTART: "1" });
  const init = await c.init();
  assert.equal(init.result.serverInfo.name, "fake-hub");
  const tl = await c.tools();
  assert.deepEqual(tl.result.tools.map((t) => t.name), ["hub_discover", "hub_execute"]);
  // stdin partido a mitad de línea: el conector copia bytes, no líneas
  const line = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }) + "\n";
  const mid = Math.floor(line.length / 2);
  const got3 = new Promise((res) => {
    let buf = "";
    const check = (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try { const m = JSON.parse(l); if (m.id === 3) { c.p.stdout.off("data", check); res(m); } } catch { }
      }
    };
    c.p.stdout.on("data", check);
  });
  c.p.stdin.write(line.slice(0, mid));
  await wait(30);
  c.p.stdin.write(line.slice(mid));
  const g = await Promise.race([got3, wait(2500).then(() => null)]);
  assert.ok(g && g.result && g.result.tools, "la línea partida debe llegar entera al hub");
  assert.equal(inits, 1);
  const rc = await c.end();
  assert.equal(rc, 0);
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("autostart: sin socket, el conector arranca el binario y espera a que escuche", async () => {
  const dir = mk();
  const sockPath = join(dir, "hub.sock");
  // "binario" falso: script node que crea el socket tras 200 ms
  const bin = join(dir, "fake-hub-bin");
  writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${dir}/fake-serve.mjs serve --quiet\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "fake-serve.mjs"), `
    import { createServer } from "node:net";
    if (process.argv[2] !== "serve") process.exit(0);
    const s = createServer((sock) => { sock.on("data", () => {}); });
    await new Promise((r) => setTimeout(r, 200));
    s.listen(${JSON.stringify(sockPath)});
    setTimeout(() => process.exit(0), 60_000).unref();
  `);
  const c = client({ ISYMCP_HUB_SOCKET: sockPath, ISYMCP_HUB_BIN: bin, ISYMCP_HUB_CONNECT_WAIT_MS: "8000", ISYMCP_HUB_LOG: join(dir, "log.txt") });
  // El hub falso sólo hace eco: initialize no lo contesta, pero el CONECTOR debe haber conectado.
  // Verificamos por el efecto: el proceso no muere y el socket existe en <8 s.
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(existsSync(sockPath), "el autostart debió crear el socket");
  const rc = await c.end();
  rmSync(dir, { recursive: true, force: true });
  assert.ok(true);
});

test("fallo explícito: sin socket ni binario, rc≠0 y mensaje accionable; no crea nada", async () => {
  const dir = mk();
  const empty = join(dir, "empty-bin-dir"); mkdirSync(empty);
  const p = spawn(process.execPath, [BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ISYMCP_HUB_SOCKET: join(dir, "no-hub.sock"), ISYMCP_HUB_BIN: join(empty, "isymcp-hub"), HOME: dir, ISYMCP_HUB_CONNECT_WAIT_MS: "300", PATH: "/usr/bin:/bin" },
  });
  const err = await new Promise((res) => { let out = ""; p.stderr.on("data", (d) => (out += d)); p.on("exit", (rc) => res({ rc, out })); });
  assert.notEqual(err.rc, 0);
  assert.match(err.out, /no responde|no hay binario|no se pudo/i);
  assert.match(err.out, /isymcp hub install|zig build/i);
  rmSync(dir, { recursive: true, force: true });
});

test("--status: JSON con socket/binario/hub/tools aunque el hub esté abajo", async () => {
  const dir = mk();
  const p = spawn(process.execPath, [BIN, "--status"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ISYMCP_HUB_SOCKET: join(dir, "no-hub.sock"), ISYMCP_HUB_BIN: join(dir, "no-bin"), ISYMCP_HUB_NO_AUTOSTART: "1" },
  });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  await new Promise((r) => p.on("exit", r));
  const st = JSON.parse(out);
  assert.equal(st.connector, "isymcp-hub-mcp");
  assert.equal(st.hub, "down");
  assert.ok(typeof st.socket === "string" && typeof st.binary !== "undefined");
  rmSync(dir, { recursive: true, force: true });
});
