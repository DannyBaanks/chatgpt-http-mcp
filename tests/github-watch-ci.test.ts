import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMonitorDatabase, LeaseAuthority, QueueService, MonitorRemoteTransport } from "../src/remote-monitor";

describe("GitHub CI Alerts & Monitor Reactive Wake-up", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "isymcp-alert-test-"));
    dbPath = join(tempDir, "monitor.sqlite");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("QueueService.submitAlertTask inserts a READY task with action metadata", () => {
    const db = openMonitorDatabase(dbPath);
    try {
      const authority = new LeaseAuthority(db, { ownerSecret: "test-owner-secret-12345678" });
      const queue = new QueueService(db, authority);

      const alert = queue.submitAlertTask({
        source: "github",
        event: "workflow_run",
        title: "GitHub CI [CI]",
        summary: "Run #42423283755 on main finished: SUCCESS",
        metadata: { run_id: "42423283755", conclusion: "success" },
      });

      expect(alert.accepted).toBe(true);
      expect(alert.state).toBe("SUCCEEDED");
      expect(alert.task_id).toMatch(/^alert-[a-f0-9]{16}$/);

      const row = db.query("SELECT * FROM tasks WHERE task_id = ?").get(alert.task_id) as any;
      expect(row).not.toBeNull();
      expect(row.kind).toBe("system_alert");
      expect(row.state).toBe("SUCCEEDED");
      expect(row.description).toContain("[ALERT:GITHUB] GitHub CI [CI]");

      const actions = JSON.parse(row.requested_actions_json);
      expect(actions[0].action).toBe("notify");
      expect(actions[0].metadata.conclusion).toBe("success");
    } finally {
      db.close();
    }
  }, 15000);

  test("MonitorRemoteTransport handles POST /isymcp/monitor/alert", async () => {
    const db = openMonitorDatabase(dbPath);
    try {
      const authority = new LeaseAuthority(db, { ownerSecret: "test-owner-secret-12345678" });
      const queue = new QueueService(db, authority);
      const transport = new MonitorRemoteTransport(queue, authority);

      const req = new Request("http://127.0.0.1:8799/isymcp/monitor/alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "github",
          title: "PR #58 Passed",
          summary: "All 766 tests green",
          metadata: { pr: 58 },
        }),
      });

      const res = await transport.handleHttpRequest(req);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.accepted).toBe(true);
      expect(data.state).toBe("SUCCEEDED");
    } finally {
      db.close();
    }
  }, 15000);

  test("MonitorRemoteTransport handles raw GitHub webhook workflow_run event", async () => {
    const db = openMonitorDatabase(dbPath);
    try {
      const authority = new LeaseAuthority(db, { ownerSecret: "test-owner-secret-12345678" });
      const queue = new QueueService(db, authority);
      const transport = new MonitorRemoteTransport(queue, authority);

      const webhookBody = {
        action: "completed",
        workflow_run: {
          id: 42423283755,
          name: "CI",
          status: "completed",
          conclusion: "success",
          head_branch: "feat/universal-media-links",
          html_url: "https://github.com/DannyBaanks/chatgpt-http-mcp/actions/runs/42423283755",
        },
        repository: {
          full_name: "DannyBaanks/chatgpt-http-mcp",
        },
      };

      const req = new Request("http://127.0.0.1:8799/isymcp/monitor/webhook/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "workflow_run",
        },
        body: JSON.stringify(webhookBody),
      });

      const res = await transport.handleHttpRequest(req);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.accepted).toBe(true);
      expect(data.task_id).toBeDefined();

      const row = db.query("SELECT * FROM tasks WHERE task_id = ?").get(data.task_id) as any;
      expect(row.description).toContain("DannyBaanks/chatgpt-http-mcp");
      expect(row.description).toContain("success");
    } finally {
      db.close();
    }
  }, 15000);
});
