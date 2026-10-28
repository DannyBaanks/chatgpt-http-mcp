// sandbox-isolation.test.ts — una sesion NO debe ver los secretos del usuario.
//
// Antes: bwrap hacia `--ro-bind / /` y nada mas, asi que una sesion read-only
// podia `cat ~/.codex-web-http/codex-sessions.json` (todos los tokens, tambien
// los writable), las cookies de ChatGPT, ~/.ssh... y sacarlos con curl.
//
// Los directorios de prueba viven bajo el repo y NO bajo /tmp: /tmp ya es un
// tmpfs dentro de la burbuja y taparia los secretos por casualidad, con lo que
// el test pasaria aunque el arreglo no existiera.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintSession, sandboxAvailable, sandboxBackend } from "../src/codex-sessions";
import { callMcpTool, ROOT } from "./helpers/mcp-call";

const SECRET = "SECRETO-QUE-NO-DEBE-SALIR";
let base: string;
let fakeHome: string;
let bridgeHome: string;
let workspace: string;

beforeAll(() => {
  const scratch = join(ROOT, ".test-tmp");
  mkdirSync(scratch, { recursive: true });
  base = mkdtempSync(join(scratch, "sandbox-"));
  fakeHome = join(base, "home");
  workspace = join(base, "ws");
  bridgeHome = join(workspace, ".codex-web-http");
  for (const dir of [fakeHome, bridgeHome, workspace]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(fakeHome, "secret.txt"), SECRET);
  process.env.CODEX_WEB_HTTP_HOME = bridgeHome;
});

afterAll(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(base, { recursive: true, force: true });
});

const env = () => ({ HOME: fakeHome, CODEX_WEB_HTTP_HOME: bridgeHome, ISYCO_TEST_LEAK: SECRET });
const backend = sandboxBackend();

function sandboxTest(name: string, callback: () => Promise<void>) {
  return backend === "docker" ? test(name, { timeout: 30_000 }, callback) : test(name, callback);
}

describe.skipIf(!sandboxAvailable())("sandbox: aislamiento de secretos", () => {
  sandboxTest("toolchains bajo $HOME siguen en PATH (ro) aunque $HOME este tapado", async () => {
    const ro = mintSession(workspace, { label: "iso-tool" });
    const command = backend === "docker" ? ["bun", "--version"] : (() => {
      const bunDir = join(fakeHome, ".bun", "bin");
      mkdirSync(bunDir, { recursive: true });
      writeFileSync(join(bunDir, "herramienta"), "#!/bin/sh\necho tool-ok\n", { mode: 0o755 });
      return [join(bunDir, "herramienta")];
    })();
    const res = await callMcpTool(bridgeHome, "codex_exec", {
      turn_token: ro.token,
      command,
    }, env());
    expect(String(res.stdout).trim().length).toBeGreaterThan(0);
  });

  sandboxTest("read-only no lee $HOME ni el registro de tokens", async () => {
    const ro = mintSession(workspace, { label: "iso-ro" });
    const res = await callMcpTool(bridgeHome, "codex_exec", {
      turn_token: ro.token,
      // Rutas citadas: el repo puede vivir en "ISyCo Git/..." (con espacio) y un
      // cat partido fallaria por eso, no por el sandbox.
      command: ["sh", "-c", `cat /home/isymcp/secret.txt; cat .codex-web-http/codex-sessions.json; true`],
    }, env());
    expect(res.executed).toBe(true);
    expect(String(res.stdout)).not.toContain(SECRET);
    expect(String(res.stdout)).not.toContain(ro.token);
  });

  sandboxTest("el env del bridge no llega al comando; HOME apunta al tmpfs", async () => {
    const ro = mintSession(workspace, { label: "iso-env" });
    const res = await callMcpTool(bridgeHome, "codex_exec", {
      turn_token: ro.token,
      command: ["sh", "-c", "env"],
    }, env());
    expect(String(res.stdout)).not.toContain(SECRET);
    expect(String(res.stdout)).toContain(`HOME=${backend === "docker" ? "/home/isymcp" : fakeHome}`);
    expect(String(res.stdout)).toContain("PATH=");
  });

  sandboxTest("sin red por defecto (solo loopback en el namespace)", async () => {
    const ro = mintSession(workspace, { label: "iso-net" });
    const res = await callMcpTool(bridgeHome, "codex_exec", {
      turn_token: ro.token,
      // /proc es nuevo dentro de la burbuja (refleja su netns); /sys no.
      command: ["sh", "-c", "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '"],
    }, env());
    expect(String(res.stdout).trim().split(/\s+/)).toEqual(["lo"]);
  });

  // --unshare-net no corta sockets Unix con ruta y conectar a uno no es
  // "escribir": con --ro-bind / / el comando llegaba a /run/user/<uid>/bus
  // (systemd-run --user = ejecutar fuera de la burbuja) y a docker.sock (root
  // si el usuario esta en el grupo docker). Escape demostrado 2026-10-28.
  test.skipIf(backend !== "bwrap")("no alcanza sockets del host (D-Bus, systemd, docker) ni /var/log", async () => {
    const uid = process.getuid?.() ?? 1000;
    const hostPaths = [
      `/run/user/${uid}/bus`,
      `/run/user/${uid}/systemd`,
      "/run/docker.sock",
      "/var/run/docker.sock",
      "/run/dbus/system_bus_socket",
      "/var/log/syslog",
    ];
    // Control: solo cuenta lo que existe en este host; si nada existe, la prueba no demostraria nada.
    const present = hostPaths.filter((p) => existsSync(p));
    expect(present.length).toBeGreaterThan(0);
    const ro = mintSession(workspace, { label: "iso-sockets" });
    const probe = present.map((p) => `test -e '${p}' && echo "VISIBLE ${p}"`).join("; ");
    const res = await callMcpTool(bridgeHome, "codex_exec", {
      turn_token: ro.token,
      command: ["sh", "-c", `${probe}; echo probe-done`],
    }, env());
    expect(res.executed).toBe(true);
    expect(String(res.stdout)).toContain("probe-done");
    expect(String(res.stdout)).not.toContain("VISIBLE");
  });

  sandboxTest("workspace que contiene el home del bridge: el registro sigue tapado", async () => {
    const outer = join(base, "outer");
    const innerBridge = join(outer, ".codex-web-http");
    mkdirSync(innerBridge, { recursive: true });
    process.env.CODEX_WEB_HTTP_HOME = innerBridge;
    try {
      const rw = mintSession(outer, { label: "iso-outer", writable: true });
      const res = await callMcpTool(innerBridge, "codex_exec", {
        turn_token: rw.token,
        command: ["sh", "-c", "cat .codex-web-http/codex-sessions.json; echo fin > visible.txt; true"],
      }, { ...env(), CODEX_WEB_HTTP_HOME: innerBridge });
      expect(res.executed).toBe(true);
      expect(String(res.stdout)).not.toContain(rw.token);
      // El workspace sigue siendo escribible.
      expect(existsSync(join(outer, "visible.txt"))).toBe(true);
    } finally {
      process.env.CODEX_WEB_HTTP_HOME = bridgeHome;
    }
  });
});
