// src/monitor/stack.ts — Armado del stack del monitor (secreto, base, servicios) y llamadas MCP con queue lease.
// (Movido sin cambios desde src/remote-monitor.ts, 2026-11-12.)
import { bridgeHome } from "../codex-sessions";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LeaseAuthority } from "./authority";
import { MonitorCoordinator } from "./coordinator";
import { openMonitorDatabase } from "./db";
import { QueueService } from "./queue";
import { MonitorRemoteTransport } from "./transport";
import { QueueLeaseRecord } from "./types";
import { WorkerAdapter } from "./worker";

export function loadOrCreateMonitorSecret(
  homeDir: string,
  filename: string,
  envOverride?: string,
): string {
  if (envOverride && envOverride.trim().length >= 16) {
    return envOverride.trim();
  }
  const secretsDir = join(homeDir, "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const secretPath = join(secretsDir, filename);
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const generated = `ms_${randomBytes(32).toString("hex")}`;
  writeFileSync(secretPath, `${generated}\n`, { mode: 0o600 });
  return generated;
}

/**
 * Abre la pila compartida del monitor sobre ~/.codex-web-http/remote-monitor.sqlite
 * (o las variables de entorno configuradas para tests de integración con el servidor MCP stdio).
 */
export function openBridgeMonitorStack(env: Record<string, string | undefined> = process.env) {
  const home = bridgeHome(env);
  mkdirSync(home, { recursive: true });
  const dbPath = env.CODEX_WEB_HTTP_MONITOR_DB?.trim() || join(home, "remote-monitor.sqlite");
  const ownerSecret = loadOrCreateMonitorSecret(
    home,
    "monitor-owner.key",
    env.CODEX_WEB_HTTP_MONITOR_OWNER_SECRET,
  );
  const workerSecret = loadOrCreateMonitorSecret(
    home,
    "monitor-worker.key",
    env.CODEX_WEB_HTTP_MONITOR_WORKER_SECRET,
  );
  const db = openMonitorDatabase(dbPath);
  const authority = new LeaseAuthority(db, { ownerSecret });
  const queue = new QueueService(db, authority);
  const worker = new WorkerAdapter({ workerSecret, db });
  const monitor = new MonitorCoordinator(db, worker);
  const transport = new MonitorRemoteTransport(queue, authority);
  return { db, dbPath, authority, queue, worker, monitor, transport, workerSecret, env };
}

/**
 * Maneja una invocación del servidor MCP (`src/mcp/main.ts`) cuando `turn_token` es un `QueueLease` (`ql_...`).
 * Garantiza que un `QueueLease` jamás pueda ejecutar comandos (`codex_exec` / `codex_apply_patch` -> DENY)
 * y que solo permita descubrir y usar `monitor_queue_submit` y `monitor_queue_status`.
 */
export function handleQueueLeaseMcpCall(
  tool: string,
  token: string,
  input: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): { isError: boolean; payload: Record<string, unknown> } {
  const { db, authority, transport } = openBridgeMonitorStack(env);
  try {
    if (
      tool === "codex_exec" ||
      tool === "codex_apply_patch" ||
      tool === "codex_write_stdin" ||
      tool === "codex_view_image"
    ) {
      return {
        isError: true,
        payload: {
          error: "DENY: queue_lease_cannot_execute",
          reason: "DENY: queue_lease_cannot_execute",
          authority: "queue_lease",
          accepted: false,
          state: "DENIED",
        },
      };
    }

    const verifyAnyScope = (): QueueLeaseRecord => {
      try {
        return authority.verifyQueueLeaseToken(token, "queue:submit");
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (msg.includes("lease_missing_scope")) {
          return authority.verifyQueueLeaseToken(token, "queue:status");
        }
        throw err;
      }
    };

    if (tool === "codex_turn_start") {
      try {
        const lease = verifyAnyScope();
        return {
          isError: false,
          payload: {
            started: true,
            authority: "queue_lease",
            lease_id: lease.lease_id,
            workspace_id: lease.workspace_id,
            scopes: lease.scopes,
            execution_allowed: false,
          },
        };
      } catch (err: any) {
        return {
          isError: true,
          payload: {
            error: String(err?.message ?? err),
            reason: String(err?.message ?? err),
            accepted: false,
            state: "DENIED",
          },
        };
      }
    }

    if (tool === "codex_tool_inventory") {
      try {
        const lease = verifyAnyScope();
        const tools = [];
        if (lease.scopes.includes("queue:submit")) {
          tools.push({
            wire_name: "monitor_queue_submit",
            name: "monitor_queue_submit",
            description:
              "Enqueue a structured task request in the local ISyMCP Remote Task Monitor (execution_started=false).",
            inputSchema: {
              type: "object",
              required: [
                "schema_version",
                "operation_id",
                "goal_id",
                "conversation_ref",
                "task",
                "idempotency_key",
                "requested_at",
              ],
              properties: {
                schema_version: { type: "number", const: 1 },
                operation_id: { type: "string" },
                goal_id: { type: "string" },
                conversation_ref: { type: "string" },
                task: {
                  type: "object",
                  required: ["kind", "workspace_id", "description", "requested_actions"],
                  properties: {
                    kind: { type: "string" },
                    workspace_id: { type: "string" },
                    description: { type: "string" },
                    requested_actions: { type: "array", items: { type: "string" } },
                    target_relpath: { type: "string" },
                    idempotent: { type: "boolean" },
                  },
                },
                idempotency_key: { type: "string" },
                requested_at: { type: "string" },
              },
            },
          });
        }
        if (lease.scopes.includes("queue:status")) {
          tools.push({
            wire_name: "monitor_queue_status",
            name: "monitor_queue_status",
            description:
              "Query status and verifiable receipt of a task in the local ISyMCP Remote Task Monitor.",
            inputSchema: {
              type: "object",
              required: ["task_id"],
              properties: {
                task_id: { type: "string" },
              },
            },
          });
        }
        return {
          isError: false,
          payload: {
            tools,
            authority: "queue_lease",
            lease_id: lease.lease_id,
            workspace_id: lease.workspace_id,
            scopes: lease.scopes,
            execution_allowed: false,
          },
        };
      } catch (err: any) {
        return {
          isError: true,
          payload: {
            error: String(err?.message ?? err),
            reason: String(err?.message ?? err),
            tools: [],
            accepted: false,
            state: "DENIED",
          },
        };
      }
    }

    if (tool === "codex_tool_call") {
      const wireName = String(input.wire_name ?? "");
      const rawArgs =
        typeof input.arguments === "object" && input.arguments !== null
          ? (input.arguments as Record<string, unknown>)
          : {};
      const res = transport.dispatchMcpTool(wireName, {
        ...rawArgs,
        lease_token: token,
      });
      const payloadObj =
        typeof res.payload === "object" && res.payload !== null
          ? (res.payload as Record<string, unknown>)
          : { result: res.payload };
      if (res.isError) {
        return {
          isError: true,
          payload: {
            error: String(payloadObj.reason ?? "DENY"),
            ...payloadObj,
          },
        };
      }
      return {
        isError: false,
        payload: payloadObj,
      };
    }

    if (tool === "codex_turn_complete") {
      try {
        const lease = verifyAnyScope();
        return {
          isError: false,
          payload: {
            completed: true,
            authority: "queue_lease",
            lease_id: lease.lease_id,
          },
        };
      } catch (err: any) {
        return {
          isError: true,
          payload: {
            error: String(err?.message ?? err),
            reason: String(err?.message ?? err),
            accepted: false,
            state: "DENIED",
          },
        };
      }
    }

    return {
      isError: true,
      payload: {
        error: `DENY: unsupported_tool_for_queue_lease:${tool}`,
        accepted: false,
        state: "DENIED",
      },
    };
  } finally {
    db.close();
  }
}
