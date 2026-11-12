// tests/taint.test.ts — tras leer contenido externo por ISyMCP, shell y consolas piden un permiso de un solo uso.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkGate, consumeOnceGrant, grantOnce, ONCE_MAX_USES, pendingOnceGrants, readAudit, runWithOperatorAuthorization, setPermission,
} from "../src/permissions";
import { activeTaint, clearTaint, markTainted, TAINT_TTL_MS, taintPath } from "../src/taint";

let home: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["CODEX_WEB_HTTP_HOME", "ISYMCP_ALLOW_HOST_SHELL", "ISYMCP_ALLOW_AGENT_SPAWN", "ISYMCP_TAINT_GATE"];
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "isymcp-taint-"));
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.CODEX_WEB_HTTP_HOME = home;
  for (const k of KEYS.slice(1)) delete process.env[k];
});
afterEach(() => {
  clearTaint();
  setPermission("host_shell", false);
  setPermission("agent_spawn", false);
  delete process.env.ISYMCP_ALLOW_HOST_SHELL;
  delete process.env.ISYMCP_TAINT_GATE;
  rmSync(join(home, "grants"), { recursive: true, force: true });
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

describe("contaminación", () => {
  it("TN-01: limpia por defecto; markTainted la abre y caduca a las 2 h de la última lectura", () => {
    expect(activeTaint()).toBeNull();
    const t0 = Date.now();
    markTainted("github.issues", "o/r", process.env, t0);
    markTainted("media_transcribe", "media_x", process.env, t0 + 60_000);
    const t = activeTaint(process.env, t0 + 61_000)!;
    expect(t.sources.map((s) => s.tool)).toEqual(["github.issues", "media_transcribe"]);
    expect(Date.parse(t.since)).toBe(t0);
    expect(Date.parse(t.until)).toBe(t0 + 60_000 + TAINT_TTL_MS);
    expect(activeTaint(process.env, t0 + 60_000 + TAINT_TTL_MS + 1)).toBeNull();
  });

  it("TN-02: un taint.json ilegible cuenta como contaminado (fail-closed)", () => {
    writeFileSync(taintPath(), "{ roto");
    expect(activeTaint()).not.toBeNull();
    expect(clearTaint()).toBe(true);
    expect(activeTaint()).toBeNull();
  });

  it("TN-03: sin home aislado en tests no toca el estado real", () => {
    const env = { NODE_ENV: "test" } as Record<string, string | undefined>;
    markTainted("github_api", "/x", env);
    expect(activeTaint()).toBeNull();
  });
});

describe("la puerta con contaminación", () => {
  it("TN-04: el permiso general (archivo o env) ya no basta y el mensaje dice qué hacer", () => {
    setPermission("host_shell", true, process.env, 60_000);
    expect(checkGate("host_shell", "shell_exec", { command: "id" }).ok).toBe(true);
    markTainted("github.issues", "evil/repo");
    const d = checkGate("host_shell", "shell_exec", { command: "id" });
    expect(d.ok).toBe(false);
    expect(d.message).toContain("isymcp allow once shell");
    expect(d.message).toContain("github.issues");
    process.env.ISYMCP_ALLOW_HOST_SHELL = "1";
    expect(checkGate("host_shell", "shell_exec", { command: "id" }).ok).toBe(false);
    const last = readAudit(1)[0]!;
    expect([last.decision, last.reason]).toEqual(["deny", "tainted"]);
    expect(String(last.taint)).toContain("github.issues");
  });

  it("TN-05: allow once deja pasar exactamente UN uso, del cap pedido", () => {
    setPermission("agent_spawn", true, process.env, 60_000);
    markTainted("media_info", "media_1");
    grantOnce("agent_spawn");
    expect(checkGate("host_shell", "shell_exec", {}).ok).toBe(false); // otro cap: no lo gasta
    expect(checkGate("agent_spawn", "tui.spawn", { agent: "claude" })).toEqual({ ok: true, source: "once" });
    expect(checkGate("agent_spawn", "tui.spawn", { agent: "claude" }).ok).toBe(false);
    expect(pendingOnceGrants("agent_spawn")).toEqual([]);
  });

  it("TN-06: --uses N da N usos; caducado no sirve y se descarta", () => {
    markTainted("github_exec", "issue view 1");
    grantOnce("host_shell", process.env, { uses: 3 });
    expect(pendingOnceGrants("host_shell")[0]!.uses).toBe(3);
    for (let i = 0; i < 3; i++) expect(checkGate("host_shell", "shell_exec", {}).source).toBe("once");
    expect(checkGate("host_shell", "shell_exec", {}).ok).toBe(false);
    expect(grantOnce("host_shell", process.env, { uses: 99 }).uses).toBe(ONCE_MAX_USES);
    rmSync(join(home, "grants"), { recursive: true, force: true });
    grantOnce("host_shell", process.env, { ttlMs: 1000 });
    expect(consumeOnceGrant("host_shell", process.env, Date.now() + 5000)).toBe(false);
    expect(readdirSync(join(home, "grants"))).toEqual([]);
  });

  it("TN-07: un permiso de un solo uso también abre la puerta cerrada (sin contaminación)", () => {
    grantOnce("host_shell");
    expect(checkGate("host_shell", "shell_exec", {}).source).toBe("once");
    expect(checkGate("host_shell", "shell_exec", {}).ok).toBe(false);
  });

  it("TN-08: el OperatorGrant del Control Center pasa aunque haya contaminación", () => {
    markTainted("github.prs", "o/r");
    expect(runWithOperatorAuthorization(() => checkGate("host_shell", "shell_exec", {}))).toEqual({ ok: true, source: "operator_grant" });
  });

  it("TN-09: ISYMCP_TAINT_GATE=0 (operador) apaga el efecto; clear también", () => {
    setPermission("host_shell", true, process.env, 60_000);
    markTainted("github_api", "/repos/o/r/issues");
    process.env.ISYMCP_TAINT_GATE = "0";
    expect(checkGate("host_shell", "shell_exec", {}).source).toBe("file");
    delete process.env.ISYMCP_TAINT_GATE;
    expect(checkGate("host_shell", "shell_exec", {}).ok).toBe(false);
    clearTaint();
    expect(checkGate("host_shell", "shell_exec", {}).source).toBe("file");
  });

  it("TN-10: dos consumidores a la vez no gastan el mismo uso dos veces", async () => {
    grantOnce("host_shell");
    const wins = await Promise.all(Array.from({ length: 8 }, async () => consumeOnceGrant("host_shell")));
    expect(wins.filter(Boolean).length).toBe(1);
  });
});

describe("qué contamina", () => {
  it("TN-11: medios: una respuesta correcta contamina; media_import (solo job_id) y los errores no", async () => {
    const { MediaService } = await import("../src/media/service");
    const { MediaCatalog } = await import("../src/media/catalog");
    const svc = new MediaService(new MediaCatalog(join(home, "media")));
    await svc.call("media_info", { asset_id: "media_00000000-0000-0000-0000-000000000000" });
    expect(activeTaint()).toBeNull(); // no existe: error, no entrega contenido
    await svc.call("media_list", {});
    expect(activeTaint()!.sources[0]!.tool).toBe("media_list");
  });

  it("TN-12: el gateway GitHub marca issues/prs/repos/api/exec, no status/whoami", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/mcp/gateway-actions.ts")).text();
    for (const t of ["github.repos", "github.prs", "github.issues"]) expect(src).toContain(`markTainted("${t}"`);
    const tools = await Bun.file(join(import.meta.dir, "../src/github/mcp-tools.ts")).text();
    expect(tools).toContain('markTainted("github_api"');
    expect(tools).toContain('markTainted("github_exec"');
    const reg = await Bun.file(join(import.meta.dir, "../src/github/register.ts")).text();
    expect(reg).toContain("GITHUB_MCP_TOOLS.github_api.handler");
    expect(reg).toContain("GITHUB_MCP_TOOLS.github_exec.handler");
  });
});
