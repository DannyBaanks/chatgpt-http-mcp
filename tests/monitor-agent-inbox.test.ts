// tests/monitor-agent-inbox.test.ts — el worker del monitor no toca el buzón de los agentes.
//
// Medido en la base real (2026-11-12): 48 de 54 tareas que ChatGPT mandó por monitor.submit fueron
// CANCELADAS por el worker en <1 s ("authorization_revoked_or_expired_before_claim"), porque no
// tienen task grant: no son para el worker, son para ARGON/las consolas. Y cada reinicio del monitor
// pasaba las tareas RUNNING de las consolas a READY, y el worker también las cancelaba.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorCoordinator, openMonitorDatabase, WorkerAdapter } from "../src/remote-monitor";
import { insertTask } from "../src/monitor/tasks";

let dir: string;
let db: ReturnType<typeof openMonitorDatabase>;
const now = 1_700_000_000_000;
const base = {
  goal_id: "GOAL-002", lease_id: "lease-mcp-submit", workspace_id: "default", kind: "review_and_test",
  description: "para ARGON", requested_actions: ["status:read"], reason: "submitted_via_gateway",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-inbox-"));
  db = openMonitorDatabase(join(dir, "m.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function coordinator() {
  return new MonitorCoordinator(db, new WorkerAdapter({ workerSecret: "w".repeat(32), nowFn: () => now }), { nowFn: () => now });
}

describe("buzón de agentes vs worker del monitor", () => {
  it("AI-01: una tarea READY sin grant (monitor.submit del gateway) no se reclama ni se cancela", () => {
    insertTask(db, { ...base, task_id: "t-inbox", operation_id: "op-1", idempotency_key: "k-1", conversation_ref: "chatgpt-mcp", state: "READY" });
    const claimed = coordinator().claimNextReadyTask();
    expect(claimed).toBeNull();
    const row = db.query("SELECT state, reason FROM tasks WHERE task_id = 't-inbox'").get() as any;
    expect(row).toEqual({ state: "READY", reason: "submitted_via_gateway" });
  });

  it("AI-02: una tarea READY CON grant revocado/inexistente se sigue cancelando (A05 intacto)", () => {
    insertTask(db, { ...base, task_id: "t-grant", operation_id: "op-2", idempotency_key: "k-2", conversation_ref: "x", state: "READY", grant_id: "grant-que-no-existe" });
    expect(coordinator().claimNextReadyTask()).toBeNull();
    const row = db.query("SELECT state, reason FROM tasks WHERE task_id = 't-grant'").get() as any;
    expect(row).toEqual({ state: "CANCELLED", reason: "authorization_revoked_or_expired_before_claim" });
  });

  it("AI-03: reiniciar el monitor no toca las tareas RUNNING de las consolas (sin worker_lease)", () => {
    insertTask(db, {
      ...base, task_id: "t-console", operation_id: "op-3", idempotency_key: "k-3", conversation_ref: "console:con-12345678",
      lease_id: "lease-local-tui", kind: "interactive_agent", state: "RUNNING", reason: "tui_session_spawned", attempt_count: 1,
    });
    const rec = coordinator().reconcileOnStartup();
    expect(rec).toEqual({ markedUnknown: [], recoveredReady: [] });
    const row = db.query("SELECT state, reason FROM tasks WHERE task_id = 't-console'").get() as any;
    expect(row).toEqual({ state: "RUNNING", reason: "tui_session_spawned" });
    expect(coordinator().claimNextReadyTask()).toBeNull();
  });

  it("AI-04: una tarea que el worker sí reclamó se sigue reconciliando (A08 intacto)", () => {
    insertTask(db, {
      ...base, task_id: "t-worker", operation_id: "op-4", idempotency_key: "k-4", conversation_ref: "x",
      state: "RUNNING", idempotent: false, worker_lease_id: "wl-abc", grant_id: "g", attempt_count: 1,
    });
    expect(coordinator().reconcileOnStartup().markedUnknown).toEqual(["t-worker"]);
  });
});
