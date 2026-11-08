import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMonitorDatabase } from "../src/remote-monitor";
import {
  consoleReport, createConsole, getConsole, listConsoles, readConsoleLog, syncAgentPid, wrapperArgv,
} from "../src/console-registry";
import { dispatchIsyMcpAction } from "../src/mcp/gateway";

let home: string;
let env: Record<string, string | undefined>;
let db: ReturnType<typeof openMonitorDatabase>;
const SECRET = "x".repeat(32);

function seedTask(id: string) {
  const now = Date.now();
  db.query(
    `INSERT INTO tasks (task_id, operation_id, idempotency_key, goal_id, conversation_ref, lease_id, workspace_id, kind, description,
      requested_actions_json, idempotent, state, reason, attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, 'g', 'console:x', 'l', 'ws', 'interactive_agent', 'd', '[]', 1, 'RUNNING', 'spawned', 1, ?, ?)`,
  ).run(id, `op-${id}`, `idem-${id}`, now, now);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "console-reg-"));
  env = { ...process.env, CODEX_WEB_HTTP_HOME: home, CODEX_WEB_HTTP_MONITOR_DB: join(home, "m.sqlite") };
  db = openMonitorDatabase(join(home, "m.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("console registry", () => {
  it("gives two consoles distinct ids, tokens and logs", () => {
    seedTask("t1"); seedTask("t2");
    const a = createConsole(db, { taskId: "t1", operationId: "op-t1", title: "A", cwd: "/tmp", workspaceId: "ws" }, env);
    const b = createConsole(db, { taskId: "t2", operationId: "op-t2", title: "B", cwd: "/tmp", workspaceId: "ws" }, env);
    expect(a.console_id).not.toBe(b.console_id);
    expect(a.token_fp).not.toBe(b.token_fp);
    expect(a.log_path).not.toBe(b.log_path);
    expect(listConsoles(db, 10, env).length).toBe(2);
  });

  it("reads the real agent PID written by the wrapper and reports liveness", () => {
    seedTask("t1");
    const c = createConsole(db, { taskId: "t1", operationId: "op-t1", title: "A", cwd: "/tmp", workspaceId: "ws" }, env);
    expect(getConsole(db, c.console_id, env)!.agent_pid).toBeNull();
    writeFileSync(c.pid_file, `${process.pid}\n`);
    expect(syncAgentPid(db, c.console_id, env)).toBe(process.pid);
    const rec = getConsole(db, "t1", env)!; // lookup by task_id
    expect(rec.alive).toBe(true);
    writeFileSync(c.pid_file, "2147480000\n");
  });

  it("ack requires the right token, keeps the task RUNNING and signs a receipt", () => {
    seedTask("t1");
    const c = createConsole(db, { taskId: "t1", operationId: "op-t1", title: "A", cwd: "/tmp", workspaceId: "ws" }, env);
    expect(() => consoleReport(db, { consoleId: c.console_id, token: "ctk_wrong", kind: "ack", summary: "x", hmacSecret: SECRET }, env))
      .toThrow("console_token_mismatch");
    const rec = consoleReport(db, { consoleId: c.console_id, token: c.ack_token, kind: "ack", summary: "listo", pid: process.pid, hmacSecret: SECRET }, env);
    expect(rec.state).toBe("ACKED");
    expect(rec.agent_pid).toBe(process.pid);
    expect(rec.ack_hmac).toBeTruthy();
    expect((db.query("SELECT state FROM tasks WHERE task_id='t1'").get() as any).state).toBe("RUNNING");
    expect(() => consoleReport(db, { consoleId: c.console_id, token: c.ack_token, kind: "ack", summary: "x", hmacSecret: SECRET }, env))
      .toThrow("already_acked");
  });

  it("one console's token cannot report for another console", () => {
    seedTask("t1"); seedTask("t2");
    const a = createConsole(db, { taskId: "t1", operationId: "op-t1", title: "A", cwd: "/tmp", workspaceId: "ws" }, env);
    const b = createConsole(db, { taskId: "t2", operationId: "op-t2", title: "B", cwd: "/tmp", workspaceId: "ws" }, env);
    expect(() => consoleReport(db, { consoleId: b.console_id, token: a.ack_token, kind: "progress", summary: "x", hmacSecret: SECRET }, env))
      .toThrow("console_token_mismatch");
  });

  it("only complete closes the task, with a receipt_hmac; log records the full lifecycle", () => {
    seedTask("t1");
    const c = createConsole(db, { taskId: "t1", operationId: "op-t1", title: "A", cwd: "/tmp", workspaceId: "ws" }, env);
    consoleReport(db, { consoleId: c.console_id, token: c.ack_token, kind: "ack", summary: "ok", hmacSecret: SECRET }, env);
    consoleReport(db, { consoleId: c.console_id, token: c.ack_token, kind: "progress", summary: "50%", hmacSecret: SECRET }, env);
    expect((db.query("SELECT state FROM tasks WHERE task_id='t1'").get() as any).state).toBe("RUNNING");
    consoleReport(db, { consoleId: c.console_id, token: c.ack_token, kind: "complete", summary: "hecho", hmacSecret: SECRET }, env);
    const row = db.query("SELECT state, receipt_hmac FROM tasks WHERE task_id='t1'").get() as any;
    expect(row.state).toBe("SUCCEEDED");
    expect(row.receipt_hmac).toBeTruthy();
    const { events } = readConsoleLog(db, c.console_id, 50);
    expect(events.map((e: any) => e.event)).toEqual(["SPAWN_REQUESTED", "ACK", "PROGRESS", "COMPLETE"]);
    expect(JSON.stringify(events)).not.toContain(c.ack_token);
  });

  it("token is stored only as a hash in SQLite and the token file is 0600", () => {
    seedTask("t1");
    const c = createConsole(db, { taskId: "t1", operationId: "op-t1", title: "A", cwd: "/tmp", workspaceId: "ws" }, env);
    const row = db.query("SELECT * FROM console_sessions").get() as any;
    expect(JSON.stringify(row)).not.toContain(c.ack_token);
    expect(existsSync(c.token_file)).toBe(true);
  });

  it("wrapper argv exports identity and execs the agent", () => {
    seedTask("t1");
    const c = createConsole(db, { taskId: "t1", operationId: "op-t1", title: "A", cwd: "/tmp", workspaceId: "ws" }, env);
    const argv = wrapperArgv(c, { taskId: "t1", operationId: "op-t1", monitorUrl: "http://x" }, ["agy", "-i", "hola"]);
    expect(argv[0]).toBe("env");
    expect(argv).toContain(`ISYMCP_CONSOLE_ID=${c.console_id}`);
    expect(argv.slice(-3)).toEqual(["agy", "-i", "hola"]);
    expect(argv.join(" ")).not.toContain(c.ack_token);
  });

  it("wrapper really records the PID of the exec'd process", async () => {
    seedTask("t1");
    const c = createConsole(db, { taskId: "t1", operationId: "op-t1", title: "A", cwd: "/tmp", workspaceId: "ws" }, env);
    const argv = wrapperArgv(c, { taskId: "t1", operationId: "op-t1", monitorUrl: "http://x" }, ["sleep", "5"]);
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(300);
    const observedPid = syncAgentPid(db, c.console_id, env);
    // Git Bash/MSYS maintains a PID namespace different from the native Win32
    // PID exposed by Bun.spawn. POSIX exec preserves its PID; Windows does not.
    if (process.platform === "win32") {
      expect(observedPid).toBeNumber();
      expect(observedPid).toBeGreaterThan(0);
    } else {
      expect(observedPid).toBe(proc.pid);
      expect(getConsole(db, c.console_id, env)!.alive).toBe(true);
    }
    proc.kill();
    await proc.exited;
    if (process.platform !== "win32") expect(getConsole(db, c.console_id, env)!.alive).toBe(false);
  });

  it("gateway tui.consoles / tui.log expose the registry", async () => {
    const saved = { h: process.env.CODEX_WEB_HTTP_HOME, d: process.env.CODEX_WEB_HTTP_MONITOR_DB };
    process.env.CODEX_WEB_HTTP_HOME = home;
    process.env.CODEX_WEB_HTTP_MONITOR_DB = join(home, "m.sqlite");
    try {
      seedTask("t1");
      const c = createConsole(db, { taskId: "t1", operationId: "op-t1", title: "A", cwd: "/tmp", workspaceId: "ws" }, env);
      const list = await dispatchIsyMcpAction("tui.consoles");
      expect(list.ok).toBe(true);
      expect((list.result as any[])[0].console_id).toBe(c.console_id);
      const listAlias = await dispatchIsyMcpAction("consoles");
      expect(listAlias.ok).toBe(true);
      expect((listAlias.result as any[])[0].console_id).toBe(c.console_id);
      const log = await dispatchIsyMcpAction("tui.log", { console_id: "t1" });
      expect(log.ok).toBe(true);
      expect((log.result as any).events.length).toBe(1);
      expect((await dispatchIsyMcpAction("tui.log", {})).ok).toBe(false);
    } finally {
      if (saved.h === undefined) delete process.env.CODEX_WEB_HTTP_HOME; else process.env.CODEX_WEB_HTTP_HOME = saved.h;
      if (saved.d === undefined) delete process.env.CODEX_WEB_HTTP_MONITOR_DB; else process.env.CODEX_WEB_HTTP_MONITOR_DB = saved.d;
    }
  });
});
