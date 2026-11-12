// tests/monitor-tasks.test.ts — un solo lugar crea y responde tareas del monitor.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMonitorDatabase } from "../src/remote-monitor";
import { ACK_TAG, hasAckTag, insertTask, respondTask, withAckTag } from "../src/monitor/tasks";

let dir: string;
let db: ReturnType<typeof openMonitorDatabase>;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "monitor-tasks-")); db = openMonitorDatabase(join(dir, "m.sqlite")); });
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const base = {
  operation_id: "op-1", idempotency_key: "idem-1", goal_id: "GOAL-002", conversation_ref: "chatgpt-mcp", lease_id: "lease-x",
  workspace_id: "default", kind: "diagnostics", description: "hola", requested_actions: ["status:read"], state: "READY", reason: "test",
};

describe("monitor/tasks", () => {
  it("MT-01: insertTask guarda todas las columnas con sus valores por defecto", () => {
    insertTask(db, { ...base, task_id: "t-1", created_at: 1000 });
    const row = db.query("SELECT * FROM tasks WHERE task_id = 't-1'").get() as any;
    expect(row).toMatchObject({
      operation_id: "op-1", idempotency_key: "idem-1", state: "READY", idempotent: 1, attempt_count: 0,
      created_at: 1000, updated_at: 1000, target_relpath: null, grant_id: null, worker_lease_id: null, result_json: null, receipt_hmac: null,
    });
    expect(JSON.parse(row.requested_actions_json)).toEqual(["status:read"]);
  });

  it("MT-02: task_id repetido falla salvo onConflictRunning, que la deja RUNNING", () => {
    expect(() => insertTask(db, { ...base, task_id: "t-1" })).toThrow();
    insertTask(db, { ...base, task_id: "t-1", created_at: 2000 }, { onConflictRunning: { reason: "tui_session_spawned" } });
    const row = db.query("SELECT state, reason, updated_at FROM tasks WHERE task_id = 't-1'").get() as any;
    expect(row).toEqual({ state: "RUNNING", reason: "tui_session_spawned", updated_at: 2000 });
  });

  it("MT-03: idempotent:false y result se guardan bien", () => {
    insertTask(db, { ...base, task_id: "t-2", operation_id: "op-2", idempotency_key: "idem-2", idempotent: false, result: { exit_code: 0 }, attempt_count: 1 });
    const row = db.query("SELECT idempotent, attempt_count, result_json FROM tasks WHERE task_id = 't-2'").get() as any;
    expect(row).toEqual({ idempotent: 0, attempt_count: 1, result_json: JSON.stringify({ exit_code: 0 }) });
  });

  it("MT-04: respondTask deja SUCCEEDED con el ACK una sola vez y su hash", () => {
    const r = respondTask(db, "t-1", "listo", 5000);
    expect(r.output_summary).toBe(`${ACK_TAG} listo`);
    expect(r.artifact_hash).toMatch(/^sha256:/);
    expect(respondTask(db, "t-1", `${ACK_TAG} otra vez`, 6000).output_summary).toBe(`${ACK_TAG} otra vez`);
    const row = db.query("SELECT state, reason, result_json FROM tasks WHERE task_id = 't-1'").get() as any;
    expect(row.state).toBe("SUCCEEDED");
    expect(row.reason).toBe("argon_personal_response");
    expect(hasAckTag(JSON.parse(row.result_json).output_summary)).toBe(true);
  });

  it("MT-05: withAckTag / hasAckTag", () => {
    expect(withAckTag("x")).toBe(`${ACK_TAG} x`);
    expect(withAckTag(`${ACK_TAG} x`)).toBe(`${ACK_TAG} x`);
    expect(hasAckTag(null)).toBe(false);
    expect(hasAckTag("algo")).toBe(false);
  });
});
