# Security Adversarial Test Matrix: ISyMCP v1.0.1 Hardening

* **Document:** `security_test_matrix.md`
* **Status:** Test Specification & Executable Harness
* **Target Version:** ISyMCP v1.0.2 / v1.1.0 Hardening Verification
* **Test Runner:** `bun test`
* **Related RFC:** [`security_boundary_rfc.md`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/security_boundary_rfc.md)

---

## Overview

This test matrix specifies 10 executable-in-principle adversarial test cases designed to validate the security invariants defined in the Security Boundary Hardening RFC. Each test case includes the target invariant, attack vector, pre-conditions, execution steps, expected outcome, and the exact TypeScript test implementation.

---

## Adversarial Test Specifications

### Test 1: Expired Session Token Rejection Fail-Closed
* **Target Invariant:** INV-3 (Capability Revocation & Fail-Closed Execution)
* **Attack Vector:** An attacker or stale client submits a tool execution request (`codex_exec`) using a previously minted session token whose TTL has expired.
* **Pre-conditions:** Session created with a 1-second TTL; clock advances past expiration.
* **Test Implementation:**
```ts
import { describe, expect, test } from "bun:test";
import { mintSession } from "../src/codex-sessions";
import { findSessionByToken } from "../src/codex-sessions";

test("SEC-TEST-01: expired session token is rejected fail-closed", async () => {
  // Mint session with 1 ms TTL (simulated by modifying expiresAt)
  const session = mintSession(process.cwd(), { ttlHours: 0 });
  session.expiresAt = new Date(Date.now() - 1000).toISOString();
  
  // Verify token validation returns null
  const resolved = findSessionByToken(session.token);
  expect(resolved).toBeNull();
});
```

---

### Test 2: Revoked Session Token Immediate Rejection
* **Target Invariant:** INV-3 (Immediate Capability Revocation)
* **Attack Vector:** A client attempts to execute commands using a session token that was explicitly revoked via `isymcp session revoke <fp>`.
* **Pre-conditions:** Valid session exists; operator invokes `revokeSession(fp)`.
* **Test Implementation:**
```ts
import { expect, test } from "bun:test";
import { mintSession, revokeSession, findSessionByToken } from "../src/codex-sessions";

test("SEC-TEST-02: revoked session token fails closed immediately", () => {
  const session = mintSession(process.cwd());
  expect(findSessionByToken(session.token)).not.toBeNull();

  // Revoke session on disk
  const revokedCount = revokeSession(session.fp);
  expect(revokedCount).toBe(1);

  // Subsequent token lookups must fail immediately
  const resolved = findSessionByToken(session.token);
  expect(resolved).toBeNull();
});
```

---

### Test 3: Unauthenticated Panel Action Rejection
* **Target Invariant:** INV-1 (Administrative Plane Protection)
* **Attack Vector:** A local unprivileged process sends an HTTP `POST /api/action` request to the panel daemon (port 8798) without supplying the `x-isymcp-token` header.
* **Pre-conditions:** Panel daemon running on loopback port.
* **Test Implementation:**
```ts
import { expect, test } from "bun:test";
import { startPanel } from "../src/panel";

test("SEC-TEST-03: panel rejects unauthenticated POST /api/action with HTTP 401", async () => {
  const panel = startPanel(8799, "8791");
  try {
    const res = await fetch("http://127.0.0.1:8799/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "server-stop" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error?.type).toBe("unauthorized");
  } finally {
    panel.stop(true);
  }
});
```

---

### Test 4: Unauthenticated Harness Mutation Rejection
* **Target Invariant:** INV-1 (Confused Deputy & Config Tampering Prevention)
* **Attack Vector:** An unauthenticated local process attempts to rewrite agent harness configurations via `POST /api/harness/apply`.
* **Pre-conditions:** Panel daemon running on loopback port.
* **Test Implementation:**
```ts
import { expect, test } from "bun:test";
import { startPanel } from "../src/panel";

test("SEC-TEST-04: panel rejects unauthenticated POST /api/harness/apply", async () => {
  const panel = startPanel(8799, "8791");
  try {
    const res = await fetch("http://127.0.0.1:8799/api/harness/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "install", ids: ["claude-code"], confirm: true }),
    });
    expect(res.status).toBe(401);
  } finally {
    panel.stop(true);
  }
});
```

---

### Test 5: Auxiliary Media Tool Omission on Public Tunnels
* **Target Invariant:** INV-2 (Zero Public Tunnel Auxiliary Tool Exposure)
* **Attack Vector:** Remote prompt caller queries tool registry across public Cloudflare tunnel to discover and invoke `media_import`.
* **Pre-conditions:** MCP server initialized in default tunnel mode (`CODEX_WEB_HTTP_EXPOSE_AUX_TOOLS` unset / `false`).
* **Test Implementation:**
```ts
import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCodexTools } from "../src/mcp/main";

test("SEC-TEST-05: auxiliary media tools are not registered on tunnel MCP server by default", async () => {
  const server = new McpServer({ name: "isymcp-test", version: "1.0.0" });
  
  // Initialize server tools with default settings
  delete process.env.CODEX_WEB_HTTP_EXPOSE_AUX_TOOLS;
  registerCodexTools(server);

  // Verify registered tool names
  const registeredTools = Object.keys((server as any)._tools ?? {});
  expect(registeredTools).not.toContain("media_import");
  expect(registeredTools).not.toContain("comfyui_generate");
  expect(registeredTools).toContain("codex_exec");
  expect(registeredTools).toContain("codex_apply_patch");
});
```

---

### Test 6: Background Process Cascade Termination upon Revocation
* **Target Invariant:** INV-3 & INV-4 (Cascade Process Termination)
* **Attack Vector:** A long-running background process continues running and consuming host CPU/network after its parent session has been revoked.
* **Pre-conditions:** Session minted; background process spawned; session revoked.
* **Test Implementation:**
```ts
import { expect, test } from "bun:test";
import { mintSession, revokeSession } from "../src/codex-sessions";
import { registerLiveExec, findLive, sweepLiveExecs } from "../src/mcp/exec-registry";

test("SEC-TEST-06: revoking a session terminates active background processes", async () => {
  const session = mintSession(process.cwd(), { ttlHours: 1 });
  const proc = Bun.spawn(["sleep", "60"], { stdout: "pipe", stderr: "pipe" });
  
  const rec = registerLiveExec({
    sessionFp: session.fp,
    command: ["sleep", "60"],
    cwd: session.cwd,
    proc: proc as any,
  });

  expect(findLive(rec.id)).not.toBeNull();

  // Revoke session on disk and trigger sweeper
  revokeSession(session.fp);
  sweepLiveExecs();

  // Process record must be removed and OS process must exit
  expect(findLive(rec.id)).toBeNull();
  const exitStatus = await Promise.race([
    proc.exited,
    Bun.sleep(1500).then(() => "still_running"),
  ]);
  expect(exitStatus).not.toBe("still_running");
});
```

---

### Test 7: Synchronous Pre-Execution Stdin Rejection on Revoked Session
* **Target Invariant:** INV-3 (Zero-Delay Revocation Enforcement)
* **Attack Vector:** A client attempts to pipe commands into an active background process via `codex_write_stdin` immediately after session revocation.
* **Pre-conditions:** Background process alive; session revoked on disk; client invokes `runWriteStdin`.
* **Test Implementation:**
```ts
import { expect, test } from "bun:test";
import { mintSession, revokeSession } from "../src/codex-sessions";
import { registerLiveExec, findLive } from "../src/mcp/exec-registry";

test("SEC-TEST-07: write_stdin fails closed synchronously when session is revoked", async () => {
  const session = mintSession(process.cwd(), { ttlHours: 1 });
  const proc = Bun.spawn(["cat"], { stdin: "pipe", stdout: "pipe" });
  
  const rec = registerLiveExec({
    sessionFp: session.fp,
    command: ["cat"],
    cwd: session.cwd,
    proc: proc as any,
  });

  // Revoke session
  revokeSession(session.fp);

  // findLive must synchronously verify disk registry and return null
  const live = findLive(rec.id);
  expect(live).toBeNull();
  
  proc.kill();
});
```

---

### Test 8: Cross-Turn Background Process Continuity
* **Target Invariant:** INV-5 (Multi-Turn Continuity via Root Parent Fingerprint)
* **Attack Vector:** Turn 2 with a new ephemeral turn token attempts to interact with a background process started in Turn 1 under the same session.
* **Pre-conditions:** Parent session mints Turn 1 token; process spawned with root FP; Turn 2 token minted.
* **Test Implementation:**
```ts
import { expect, test } from "bun:test";
import { mintSession, mintTurnToken } from "../src/codex-sessions";
import { registerLiveExec } from "../src/mcp/exec-registry";

test("SEC-TEST-08: multi-turn prompt can manage background process across turns", () => {
  const rootSession = mintSession(process.cwd());
  const turn1 = mintTurnToken(rootSession.token);
  const turn2 = mintTurnToken(rootSession.token);

  // Register process using root parent fingerprint
  const rec = registerLiveExec({
    sessionFp: turn1.parent ?? turn1.fp,
    command: ["npm", "run", "dev"],
    cwd: rootSession.cwd,
    proc: { pid: 99999, kill: () => {} } as any,
  });

  // Turn 2 verifies ownership against root FP
  const turn2RootFp = turn2.parent ?? turn2.fp;
  expect(rec.sessionFp).toBe(turn2RootFp);
});
```

---

### Test 9: Patch Traversal Symlink Rejection
* **Target Invariant:** INV-6 (Symlink Realpath Workspace Confinement)
* **Attack Vector:** An attacker constructs a patch targeting a workspace symlink that points to an external directory (e.g., `/etc` or user home).
* **Pre-conditions:** Workspace contains symlink pointing to temporary outside directory.
* **Test Implementation:**
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintSession, resolveWithinReal } from "../src/codex-sessions";

test("SEC-TEST-09: resolveWithinReal rejects symlinks pointing outside workspace", () => {
  const wsDir = mkdtempSync(join(tmpdir(), "sec-test-ws-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "sec-test-out-"));
  const linkPath = join(wsDir, "escape_link");

  try {
    symlinkSync(outsideDir, linkPath);
    
    // Attempting to resolve path through the escape symlink must fail
    const targetFile = join(linkPath, "secret.txt");
    expect(() => resolveWithinReal(wsDir, targetFile)).toThrow(/fuera del workspace/i);
  } finally {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
```

---

### Test 10: Complete Process Tree Termination (Cross-Platform)
* **Target Invariant:** INV-4 (Cross-Platform Process Tree Elimination)
* **Attack Vector:** A command spawns sub-processes (e.g. `bash -c 'sleep 100 &'`). Terminating the parent process must not leave the sub-process running as an orphaned zombie.
* **Pre-conditions:** Process hierarchy spawned; `stopProcessTree` invoked.
* **Test Implementation:**
```ts
test("SEC-TEST-10: stopProcessTree terminates process hierarchy including descendants", async () => {
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
```

---

### Test 11: Unauthenticated GET / Token Leak Prevention (The GPT Regression Test)
* **Target Invariant:** INV-1 (Zero Secret Leakage on Unauthenticated Loopback)
* **Attack Vector:** An unprivileged local process sends `curl http://127.0.0.1:8798/` to read the HTML and extract `bridgeToken()` or session secrets to bypass file permissions `0600`.
* **Pre-conditions:** Panel daemon running on loopback port.
* **Test Implementation:**
```ts
test("SEC-TEST-11: unauthenticated GET / returns 401 login card and NEVER leaks bridgeToken in HTML", async () => {
  const { bridgeToken } = await import("../src/local-guard");
  const realToken = bridgeToken();
  const panel = startPanel(0, "59999");
  try {
    // 1. Unauthenticated GET / must return 401
    const res = await fetch(`http://127.0.0.1:${panel.port}/`);
    expect(res.status).toBe(401);
    const html = await res.text();
    
    // 2. The HTML MUST NOT contain the bridge token or any token injection
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

    // 4. Ticket is burned (single use): redeeming again must fail
    const replayRes = await fetch(`http://127.0.0.1:${panel.port}/?ticket=${ticket}`, {
      redirect: "manual",
    });
    expect(replayRes.status).toBe(401);

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
```

---

## CI / CD Execution Harness

All 11 test cases are compiled into [`tests/security-boundary.test.ts`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/tests/security-boundary.test.ts) and integrated directly into the primary CI test run:

```bash
bun test tests/security-boundary.test.ts
```
