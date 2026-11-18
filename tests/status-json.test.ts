import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// El home del bridge se fija ANTES del import: services.ts calcula rutas al cargar.
// Nunca se toca ~/.codex-web-http real.
const prevHome = process.env.CODEX_WEB_HTTP_HOME;
const prevShell = process.env.ISYMCP_ALLOW_HOST_SHELL;
const prevAgents = process.env.ISYMCP_ALLOW_AGENT_SPAWN;
const home = mkdtempSync(join(tmpdir(), "isymcp-status-json-"));
process.env.CODEX_WEB_HTTP_HOME = home;
delete process.env.ISYMCP_ALLOW_HOST_SHELL;
delete process.env.ISYMCP_ALLOW_AGENT_SPAWN;
const { collectStatus } = await import("../src/cli/commands/status");

const TOKEN = "tok-test-secret-do-not-print-0123456789";
const shellUntil = new Date(Date.now() + 3600_000).toISOString();

beforeAll(() => {
  mkdirSync(join(home, "canary"), { recursive: true });
  writeFileSync(join(home, "canary", "latest.json"), JSON.stringify({ ts: "2026-11-18T10:00:00.000Z", ok: true, bridge: "existing", checks: [] }));
  writeFileSync(join(home, "permissions.json"), JSON.stringify({ host_shell: true, host_shell_until: shellUntil }));
  writeFileSync(join(home, "codex-sessions.json"), JSON.stringify({
    schema: "codex-web-http.codex-sessions/1",
    sessions: [
      { token: TOKEN, fp: "fp-live-0001", label: "live", cwd: home, writable: false, createdAt: "2026-11-18T09:00:00.000Z", expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      { token: "x".repeat(40), fp: "fp-old-0002", label: "old", cwd: home, writable: true, createdAt: "2026-11-01T09:00:00.000Z", expiresAt: "2026-11-02T09:00:00.000Z" },
    ],
  }), { mode: 0o600 });
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.CODEX_WEB_HTTP_HOME; else process.env.CODEX_WEB_HTTP_HOME = prevHome;
  if (prevShell !== undefined) process.env.ISYMCP_ALLOW_HOST_SHELL = prevShell;
  if (prevAgents !== undefined) process.env.ISYMCP_ALLOW_AGENT_SPAWN = prevAgents;
  rmSync(home, { recursive: true, force: true });
});

const isStr = (v: unknown) => typeof v === "string";
const isBool = (v: unknown) => typeof v === "boolean";
const isNullOr = (v: unknown, check: (x: unknown) => boolean) => v === null || check(v);

describe("isymcp status --json (collectStatus)", () => {
  test("devuelve todas las claves del contrato isymcp-status/1 con tipos correctos", async () => {
    const s = await collectStatus();
    expect(Object.keys(s).sort()).toEqual(
      ["canary", "chatgpt", "connector", "conversation", "gates", "mcp", "monitor", "panel", "server", "sessions", "taint", "tasks", "ts", "tunnel", "version"],
    );
    expect(s.version).toBe("isymcp-status/1");
    expect(Number.isFinite(Date.parse(s.ts))).toBe(true);

    expect(isBool(s.server.up)).toBe(true);
    expect(s.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(isNullOr(s.server.pid, (x) => typeof x === "number")).toBe(true);
    expect(isStr(s.server.log)).toBe(true);

    expect(isBool(s.tunnel.ready)).toBe(true);
    expect(isNullOr(s.tunnel.running, isBool)).toBe(true);
    expect(isStr(s.tunnel.state)).toBe(true);
    // Sin tunnel-client en el home temporal: no imprime, no lanza, y lo dice.
    expect(s.tunnel).toEqual({ ready: false, running: null, state: "no instalado" });

    expect(isBool(s.mcp.up)).toBe(true);
    expect(isStr(s.connector)).toBe(true);
    expect(isNullOr(s.conversation, isStr)).toBe(true);

    expect(Array.isArray(s.sessions)).toBe(true);
    for (const x of s.sessions) {
      expect(isStr(x.label)).toBe(true);
      expect(isStr(x.fp)).toBe(true);
      expect(isBool(x.writable)).toBe(true);
      expect(isBool(x.expired)).toBe(true);
    }

    expect(isBool(s.panel.up)).toBe(true);
    expect(isStr(s.panel.url)).toBe(true);
    expect(isBool(s.monitor.up)).toBe(true);
    expect(isStr(s.monitor.url)).toBe(true);
    expect(isNullOr(s.monitor.pid, (x) => typeof x === "number")).toBe(true);

    expect(isNullOr(s.chatgpt, isStr)).toBe(true);
    expect(s.canary === null || (isBool(s.canary.ok) && isStr(s.canary.ts))).toBe(true);
    expect(s.tasks === null || (typeof s.tasks.total === "number" && typeof s.tasks.blocked === "number")).toBe(true);

    for (const gate of [s.gates.shell, s.gates.agents]) {
      expect(isBool(gate.on)).toBe(true);
      expect(isNullOr(gate.expires, isStr)).toBe(true);
    }
    expect(isBool(s.taint.tainted)).toBe(true);
    expect(isNullOr(s.taint.until, isStr)).toBe(true);
  }, 20000);

  test("refleja permisos, sesiones y canario del home aislado, sin filtrar tokens", async () => {
    const s = await collectStatus();
    expect(s.gates.shell.on).toBe(true);
    expect(s.gates.shell.expires).toBe(shellUntil);
    expect(s.gates.agents).toEqual({ on: false, expires: null });
    expect(s.taint).toEqual({ tainted: false, until: null });

    const live = s.sessions.find((x) => x.label === "live");
    const old = s.sessions.find((x) => x.label === "old");
    expect(live).toEqual({ label: "live", fp: "fp-live-0001", writable: false, expired: false });
    expect(old).toEqual({ label: "old", fp: "fp-old-0002", writable: true, expired: true });

    expect(s.canary).toEqual({ ok: true, ts: "2026-11-18T10:00:00.000Z" });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  }, 20000);
});
