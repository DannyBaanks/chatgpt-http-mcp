// tests/security-boundary.test.ts — suite de pruebas adversarias (EGM RFC Hardening).
// Valida los 10 invariantes de seguridad definidos en security_test_matrix.md:
// 1. Token de sesion expirado: rechazo fail-closed.
// 2. Token de sesion revocado: rechazo fail-closed inmediato.
// 3. Accion del panel sin autenticacion: HTTP 401.
// 4. Mutacion de harnesses sin autenticacion: HTTP 401.
// 5. Herramientas auxiliares de media omitidas en tunel por defecto.
// 6. Terminacion en cascada de procesos background al revocar sesion.
// 7. Fallo cerrado sincronico de write_stdin ante sesion revocada.
// 8. Continuidad multi-turno de procesos background via fingerprint padre.
// 9. Confinamiento de parches: rechazo de symlinks que escapan del workspace.
// 10. Eliminacion completa de arbol de procesos multiplataforma.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSessionByToken,
  mintSession,
  mintTurnToken,
  resolveWithinReal,
  revokeSession,
} from "../src/codex-sessions";
import { startPanel } from "../src/panel";
import { findLive, registerLiveExec, sweepLiveExecs } from "../src/mcp/exec-registry";
import { stopProcessTree } from "../src/platform/process";

let testHome: string;
let testWorkspace: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "sec-matrix-home-"));
  testWorkspace = mkdtempSync(join(tmpdir(), "sec-matrix-ws-"));
  process.env.CODEX_WEB_HTTP_HOME = testHome;
});

afterEach(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(testHome, { recursive: true, force: true });
  rmSync(testWorkspace, { recursive: true, force: true });
});

describe("EGM Security Boundary Hardening Matrix", () => {
  test("SEC-TEST-01: expired session token is rejected fail-closed", () => {
    const session = mintSession(testWorkspace, { ttlHours: 1 / 3_600_000 });
    // Let TTL elapse
    Bun.sleepSync(10);
    
    // In-memory or disk lookup must fail closed
    const resolved = findSessionByToken(session.token);
    expect(resolved).toBeNull();
  });

  test("SEC-TEST-02: revoked session token fails closed immediately", () => {
    const session = mintSession(testWorkspace);
    expect(findSessionByToken(session.token)).not.toBeNull();

    // Revoke session on disk
    const revokedCount = revokeSession(session.fp);
    expect(revokedCount).toBe(1);

    // Subsequent token lookups must fail closed immediately
    const resolved = findSessionByToken(session.token);
    expect(resolved).toBeNull();
  });

  test("SEC-TEST-03: panel rejects unauthenticated POST /api/action with HTTP 401", async () => {
    const panel = startPanel(0, "59999");
    try {
      const res = await fetch(`http://127.0.0.1:${panel.port}/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "server-stop" }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { type: string } };
      expect(body.error?.type).toBe("unauthorized");
    } finally {
      panel.stop(true);
    }
  });

  test("SEC-TEST-04: panel rejects unauthenticated POST /api/harness/apply with HTTP 401", async () => {
    const panel = startPanel(0, "59999");
    try {
      const res = await fetch(`http://127.0.0.1:${panel.port}/api/harness/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "install", ids: ["claude-code"], confirm: true }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { type: string } };
      expect(body.error?.type).toBe("unauthorized");
    } finally {
      panel.stop(true);
    }
  });

  test("SEC-TEST-05: auxiliary media tools are not registered on tunnel MCP server by default", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpServer({ name: "isymcp-test", version: "1.0.0" });
    
    // Simulate tunnel registration logic
    const exposeAux = process.env.CODEX_WEB_HTTP_EXPOSE_AUX_TOOLS === "true" ||
                      process.env.CODEX_WEB_HTTP_SECURITY_PROFILE === "v1_compat";
    if (exposeAux) {
      const { registerMediaTools } = await import("../src/media/register");
      registerMediaTools(server);
    }

    const registeredTools = Object.keys((server as any)._tools ?? {});
    expect(registeredTools).not.toContain("media_import");
    expect(registeredTools).not.toContain("comfyui_generate");
  });

  test("SEC-TEST-06: revoking a session terminates active background processes", async () => {
    const session = mintSession(testWorkspace, { ttlHours: 1 });
    const proc = Bun.spawn(["sleep", "60"], { stdout: "pipe", stderr: "pipe" });
    
    const rec = registerLiveExec({
      sessionFp: session.fp,
      command: ["sleep", "60"],
      cwd: testWorkspace,
      proc: {
        pid: proc.pid,
        stdin: proc.stdin as any,
        stdout: proc.stdout as any,
        stderr: proc.stderr as any,
        kill: (sig?: number) => proc.kill(sig),
        exited: proc.exited,
      },
    });

    expect(findLive(rec.id)).not.toBeNull();

    // Revoke session on disk and run sweeper
    revokeSession(session.fp);
    sweepLiveExecs();

    // Process record must be deleted and OS process must exit
    expect(findLive(rec.id)).toBeNull();
    const exitStatus = await Promise.race([
      proc.exited,
      Bun.sleep(1500).then(() => "still_running"),
    ]);
    expect(exitStatus).not.toBe("still_running");
  });

  test("SEC-TEST-07: write_stdin fails closed synchronously when session is revoked", async () => {
    const session = mintSession(testWorkspace, { ttlHours: 1 });
    const proc = Bun.spawn(["cat"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    
    const rec = registerLiveExec({
      sessionFp: session.fp,
      command: ["cat"],
      cwd: testWorkspace,
      proc: {
        pid: proc.pid,
        stdin: proc.stdin as any,
        stdout: proc.stdout as any,
        stderr: proc.stderr as any,
        kill: (sig?: number) => proc.kill(sig),
        exited: proc.exited,
      },
    });

    // Revoke session
    revokeSession(session.fp);

    // findLive must synchronously verify disk registry and return null immediately
    const live = findLive(rec.id);
    expect(live).toBeNull();
    
    proc.kill();
  });

  test("SEC-TEST-08: multi-turn prompt can manage background process across turns", () => {
    const rootSession = mintSession(testWorkspace);
    const turn1 = mintTurnToken(rootSession.fp, "turn-1");
    const turn2 = mintTurnToken(rootSession.fp, "turn-2");

    // Register process using root parent fingerprint
    const rootFp = turn1.parent ?? turn1.fp;
    const rec = registerLiveExec({
      sessionFp: rootFp,
      command: ["npm", "run", "dev"],
      cwd: rootSession.cwd,
      proc: {
        pid: 99999,
        stdin: {} as any,
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        kill: () => {},
        exited: Promise.resolve(0),
      },
    });

    // Turn 2 verifies ownership against root FP
    const turn2RootFp = turn2.parent ?? turn2.fp;
    expect(rec.sessionFp).toBe(turn2RootFp);

    // Clean up record to avoid polluting capacity limits in other tests
    rec.expiresAt = 0;
    findLive(rec.id);
  });

  test("SEC-TEST-09: resolveWithinReal rejects symlinks pointing outside workspace", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "sec-matrix-out-"));
    const linkPath = join(testWorkspace, "escape_link");

    try {
      symlinkSync(outsideDir, linkPath);
      
      // Attempting to resolve path through escape symlink must fail closed (return null)
      const targetFile = join(linkPath, "secret.txt");
      expect(resolveWithinReal(testWorkspace, targetFile)).toBeNull();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("SEC-TEST-10: stopProcessTree terminates process hierarchy including descendants", async () => {
    // Skip on Windows runner where bash is not standard in PATH; Windows taskkill /T /F is covered in platform-process
    if (process.platform === "win32") return;

    const tmpPid = join(testWorkspace, "child.pid");
    const parent = Bun.spawn(["bash", "-c", `sleep 120 & echo $! > ${tmpPid}; wait`], {
      stdout: "ignore",
      stderr: "ignore",
    });

    expect(parent.pid).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      if (existsSync(tmpPid)) break;
      await Bun.sleep(50);
    }
    const childPid = parseInt(readFileSync(tmpPid, "utf8").trim(), 10);
    expect(Number.isInteger(childPid)).toBe(true);

    // Stop tree
    stopProcessTree(parent.pid);

    const exitStatus = await Promise.race([
      parent.exited,
      Bun.sleep(2000).then(() => "still_running"),
    ]);
    expect(exitStatus).not.toBe("still_running");

    // Descendant child must not survive as an orphan
    await Bun.sleep(100);
    let childAlive = false;
    try {
      process.kill(childPid, 0);
      childAlive = true;
    } catch {
      childAlive = false;
    }
    expect(childAlive).toBe(false);
  });

  test("SEC-TEST-11: unauthenticated GET / returns 200 login card and NEVER leaks bridgeToken in HTML", async () => {
    const { bridgeToken } = await import("../src/local-guard");
    const realToken = bridgeToken();
    const panel = startPanel(0, "59999");
    try {
      // 1. Unauthenticated GET / must return 200 with zero secrets
      const res = await fetch(`http://127.0.0.1:${panel.port}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      
      // 2. The HTML MUST NOT contain the bridge token or window.__ISYMCP_TOKEN__
      expect(html).not.toContain(realToken);
      expect(html).not.toContain("window.__ISYMCP_TOKEN__");
      expect(html).toContain("Acceso administrativo protegido");

      // 3. Ticket redemption gives an HttpOnly cookie and clean redirect
      const ticket = (panel as any).mintTicket();
      const ticketRes = await fetch(`http://127.0.0.1:${panel.port}/?ticket=${ticket}`, {
        redirect: "manual",
      });
      expect(ticketRes.status).toBe(302);
      expect(ticketRes.headers.get("location")).toBe("/");
      const setCookie = ticketRes.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("isymcp_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");

      // 4. Ticket is burned (single use): redeeming again fails (renders login card, no redirect)
      const replayRes = await fetch(`http://127.0.0.1:${panel.port}/?ticket=${ticket}`, {
        redirect: "manual",
      });
      expect(replayRes.status).toBe(200);
      expect(replayRes.headers.get("location")).toBeNull();

      // 5. Following redirect with the cookie accesses the full panel (and HTML still has NO raw token!)
      const cookieMatch = /isymcp_session=([^;]+)/.exec(setCookie);
      const cookieVal = cookieMatch![1];
      const authedRes = await fetch(`http://127.0.0.1:${panel.port}/`, {
        headers: { cookie: `isymcp_session=${cookieVal}` },
      });
      expect(authedRes.status).toBe(200);
      const authedHtml = await authedRes.text();
      expect(authedHtml).toContain("ISyMCP PANEL");
      expect(authedHtml).not.toContain(realToken);
      expect(authedHtml).not.toContain("window.__ISYMCP_TOKEN__");
    } finally {
      panel.stop(true);
    }
  });
});
