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
import { mintSession, sandboxAvailable } from "../src/codex-sessions";
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
  bridgeHome = join(base, "bridge");
  workspace = join(base, "ws");
  for (const dir of [fakeHome, bridgeHome, workspace]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(fakeHome, "secret.txt"), SECRET);
  process.env.CODEX_WEB_HTTP_HOME = bridgeHome;
});

afterAll(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(base, { recursive: true, force: true });
});

const env = () => ({ HOME: fakeHome, CODEX_WEB_HTTP_HOME: bridgeHome, ISYCO_TEST_LEAK: SECRET });

describe.skipIf(!sandboxAvailable())("sandbox: aislamiento de secretos", () => {
  test("toolchains bajo $HOME siguen en PATH (ro) aunque $HOME este tapado", async () => {
    const bunDir = join(fakeHome, ".bun", "bin");
    mkdirSync(bunDir, { recursive: true });
    writeFileSync(join(bunDir, "herramienta"), "#!/bin/sh\necho tool-ok\n", { mode: 0o755 });
    const ro = mintSession(workspace, { label: "iso-tool" });
    const res = await callMcpTool(bridgeHome, "codex_exec", {
      turn_token: ro.token,
      command: [join(bunDir, "herramienta")],
    }, env());
    expect(String(res.stdout)).toContain("tool-ok");
  });

  test("read-only no lee $HOME ni el registro de tokens", async () => {
    const ro = mintSession(workspace, { label: "iso-ro" });
    const res = await callMcpTool(bridgeHome, "codex_exec", {
      turn_token: ro.token,
      // Rutas citadas: el repo puede vivir en "ISyCo Git/..." (con espacio) y un
      // cat partido fallaria por eso, no por el sandbox.
      command: ["sh", "-c", `cat ${JSON.stringify(join(fakeHome, "secret.txt"))}; cat ${JSON.stringify(join(bridgeHome, "codex-sessions.json"))}; true`],
    }, env());
    expect(res.executed).toBe(true);
    expect(String(res.stdout)).not.toContain(SECRET);
    expect(String(res.stdout)).not.toContain(ro.token);
  });

  test("el env del bridge no llega al comando; HOME apunta al tmpfs", async () => {
    const ro = mintSession(workspace, { label: "iso-env" });
    const res = await callMcpTool(bridgeHome, "codex_exec", {
      turn_token: ro.token,
      command: ["sh", "-c", "env"],
    }, env());
    expect(String(res.stdout)).not.toContain(SECRET);
    expect(String(res.stdout)).toContain(`HOME=${fakeHome}`);
    expect(String(res.stdout)).toContain("PATH=");
  });

  test("sin red por defecto (solo loopback en el namespace)", async () => {
    const ro = mintSession(workspace, { label: "iso-net" });
    const res = await callMcpTool(bridgeHome, "codex_exec", {
      turn_token: ro.token,
      // /proc es nuevo dentro de la burbuja (refleja su netns); /sys no.
      command: ["sh", "-c", "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '"],
    }, env());
    expect(String(res.stdout).trim().split(/\s+/)).toEqual(["lo"]);
  });

  test("workspace que contiene el home del bridge: el registro sigue tapado", async () => {
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
