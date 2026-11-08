// src/control-center/service.ts — Servicios backend para el ISyMCP Control Center.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { bridgeAuthHeaders } from "../local-guard";
import { bridgeHome } from "../codex-sessions";
import { processMatchesTable } from "../platform/process";
import { openBridgeMonitorStack, type TaskRecord } from "../remote-monitor";
import { ISYMCP_GLOSSARY, dispatchIsyMcpAction } from "../mcp/gateway";
import { ISYMCP_AGENT_PROTOCOL_MD } from "../agent-protocol";
import type {
  ControlCenterOverview,
  ControlCenterTaskItem,
  ControlCenterDispatchResponse,
  ServiceHealthItem,
} from "./contracts";

const DANGEROUS_ACTIONS = new Set([
  "shell.exec",
  "github.dispatch",
  "github.exec",
  "github.api",
]);

const ACTION_ALIAS_MAP: Record<string, string> = {
  shell: "shell.exec",
  exec: "shell.exec",
  bash: "shell.exec",
  cmd: "shell.exec",
  sh: "shell.exec",
  tui: "tui.spawn",
  spawn: "tui.spawn",
  dispatch: "github.dispatch",
  protocol: "protocol.read",
  agents: "protocol.read",
  fuzz: "fuzz.run",
  status: "monitor.status",
  tasks: "monitor.tasks",
  respond: "monitor.respond",
  submit: "monitor.submit",
};

function sanitizeOutput(data: unknown): unknown {
  if (typeof data === "string") {
    // Redactar tokens y secrets que puedan haber llegado
    return data
      .replace(/(ghp_[A-Za-z0-9_]{36,})/g, "[REDACTED_GH_TOKEN]")
      .replace(/(x-isymcp-token:\s*)[^\s\r\n]+/gi, "$1[REDACTED]")
      .replace(/(ql_[A-Za-z0-9_-]{20,})/g, "[REDACTED_LEASE_TOKEN]")
      .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(data)) {
    return data.map(sanitizeOutput);
  }
  if (data !== null && typeof data === "object") {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (/token|secret|password|key/i.test(k) && typeof v === "string" && v.length > 10) {
        clean[k] = "[REDACTED]";
      } else {
        clean[k] = sanitizeOutput(v);
      }
    }
    return clean;
  }
  return data;
}

export async function getControlCenterOverview(bridgePort = "8791"): Promise<ControlCenterOverview> {
  const monitorPort = process.env.ISYMCP_MONITOR_PORT?.trim() || "8799";
  const services: ServiceHealthItem[] = [];

  // 1. Bridge Server (:8791)
  let bridgeStatus: "up" | "down" = "down";
  let bridgeAuth: "ok" | "token_required" = "ok";
  try {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/health`, {
      headers: bridgeAuthHeaders(),
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      bridgeStatus = "up";
    } else if (res.status === 401) {
      bridgeStatus = "up";
      bridgeAuth = "token_required";
    }
  } catch {
    bridgeStatus = "down";
  }

  services.push({
    id: "bridge",
    name: "Codex HTTP Bridge",
    status: bridgeStatus,
    detail: bridgeStatus === "up" ? `Escuchando en :${bridgePort}` : "Apagado",
    endpoint: `http://127.0.0.1:${bridgePort}`,
  });

  // 2. Monitor Continuo (:8799)
  let monitorStatus: "up" | "down" = "down";
  let monitorPid: number | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${monitorPort}/ready`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { pid?: number };
      monitorStatus = "up";
      monitorPid = data.pid ?? null;
    }
  } catch {
    monitorStatus = "down";
  }

  services.push({
    id: "monitor",
    name: "ISyMCP Resident Monitor",
    status: monitorStatus,
    detail: monitorStatus === "up" ? `Activo en :${monitorPort} (PID ${monitorPid ?? "—"})` : "Inactivo",
    endpoint: `http://127.0.0.1:${monitorPort}`,
    pid: monitorPid,
  });

  // 3. Procesos de túnel y broker MCP
  const [tunnelUp, brokerMain, brokerName, brokerSock] = processMatchesTable([
    "tunnel-client",
    "mcp/main.ts --contract native --broker",
    "isymcp-broker",
    "broker.sock",
  ]);
  const tunnelStatus = tunnelUp ? "ready" : "stopped";
  const mcpStatus = brokerMain || brokerName || brokerSock ? "up" : "down";

  services.push({
    id: "tunnel",
    name: "Cloudflare / Reverse Tunnel",
    status: tunnelStatus,
    detail: tunnelStatus === "ready" ? "Proceso tunnel-client en ejecución" : "No conectado",
  });

  services.push({
    id: "mcp-broker",
    name: "MCP Gateway & Broker",
    status: mcpStatus,
    detail: mcpStatus === "up" ? "Broker Unix socket activo" : "Detenido",
  });

  // 4. Métricas de cola y leases (desde SQLite WAL)
  let activeLeasesCount = 0;
  let totalTasksCount = 0;
  let unackedTasksCount = 0;

  try {
    const { db } = openBridgeMonitorStack();
    try {
      const now = Date.now();
      const leaseRow = db
        .query("SELECT COUNT(*) as count FROM queue_leases WHERE revoked_at IS NULL AND expires_at > ?")
        .get(now) as { count: number } | null;
      activeLeasesCount = leaseRow?.count ?? 0;

      const tasksRow = db.query("SELECT COUNT(*) as count FROM tasks").get() as { count: number } | null;
      totalTasksCount = tasksRow?.count ?? 0;

      const unackedRow = db
        .query(
          "SELECT COUNT(*) as count FROM tasks WHERE state NOT IN ('SUCCEEDED', 'CANCELLED', 'FAILED') OR (state = 'SUCCEEDED' AND reason != 'argon_personal_response')"
        )
        .get() as { count: number } | null;
      unackedTasksCount = unackedRow?.count ?? 0;
    } finally {
      db.close();
    }
  } catch {
    /* base de datos no inicializada aún */
  }

  // 5. Métricas del sistema
  const mem = process.memoryUsage();
  const metrics = {
    memoryRssMb: Math.round(mem.rss / (1024 * 1024)),
    uptimeSeconds: Math.round(process.uptime()),
  };

  return {
    ts: new Date().toISOString(),
    services,
    monitor: {
      status: monitorStatus,
      url: `http://127.0.0.1:${monitorPort}`,
      pid: monitorPid,
      activeLeasesCount,
      totalTasksCount,
      unackedTasksCount,
    },
    bridge: {
      port: bridgePort,
      status: bridgeStatus,
      auth: bridgeAuth,
      tunnel: tunnelStatus,
      activeBroker: tunnelStatus === "ready" || mcpStatus === "up",
    },
    metrics,
  };
}

export function getControlCenterGlossary() {
  return ISYMCP_GLOSSARY;
}

export function getControlCenterProtocol(): string {
  return ISYMCP_AGENT_PROTOCOL_MD;
}

export function getControlCenterTasks(
  limit = 50,
  env: Record<string, string | undefined> = process.env
): ControlCenterTaskItem[] {
  const { db, monitor } = openBridgeMonitorStack(env);
  try {
    const records = monitor.listTasks(limit);
    return records.map((t: TaskRecord) => ({
      task_id: t.task_id,
      operation_id: t.operation_id,
      workspace_id: t.workspace_id,
      kind: t.kind,
      description: t.description,
      state: t.state,
      requested_actions: t.requested_actions,
      attempt_count: t.attempt_count,
      created_at: t.created_at,
      updated_at: t.updated_at,
      has_receipt: Boolean(t.receipt_hmac),
      receipt_hmac: t.receipt_hmac ? t.receipt_hmac.slice(0, 16) + "…" : null,
      result_summary: t.result?.output_summary ?? null,
      exit_code: t.result?.exit_code ?? null,
    }));
  } finally {
    db.close();
  }
}

export function approveControlCenterTask(taskId: string): { ok: boolean; task?: unknown; error?: string } {
  if (!taskId || typeof taskId !== "string") {
    return { ok: false, error: "task_id inválido o requerido" };
  }
  const { db, authority, monitor } = openBridgeMonitorStack();
  try {
    const task = monitor.inspectTask(taskId);
    if (!task) return { ok: false, error: `No existe la tarea: ${taskId}` };
    const ownerId = "local_owner";
    const ogGrant = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["task:grant"] });
    const grant = authority.createTaskGrant(ogGrant, {
      workspace_id: task.workspace_id,
      allowed_kinds: [task.kind],
      allowed_actions: task.requested_actions.length > 0 ? task.requested_actions : ["tests:run", "status:read"],
    });
    const ogApprove = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["task:grant"] });
    const updated = authority.authorizePendingTask(ogApprove, {
      task_id: taskId,
      grant_id: grant.grant_id,
    });
    return { ok: true, task: updated };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    db.close();
  }
}

export async function dispatchControlCenterAction(
  action: string,
  args: Record<string, unknown> = {},
  options: { confirmed?: boolean } = {}
): Promise<ControlCenterDispatchResponse> {
  const normAction = (action || "").trim().toLowerCase();
  const canonicalAction = ACTION_ALIAS_MAP[normAction] ?? normAction;

  // Comprobar si es un comando peligroso
  const isDangerous =
    DANGEROUS_ACTIONS.has(canonicalAction) ||
    (canonicalAction === "tui.spawn" &&
      (args.mode === "accept-edits" || args.dangerously_skip_permissions === true));

  if (isDangerous && options.confirmed !== true) {
    let warningMsg = "Esta acción puede modificar el sistema, ejecutar código en el host o alterar repositorios.";
    if (canonicalAction === "shell.exec") {
      warningMsg = `Ejecución de shell arbitraria: se requiere confirmación explícita para ejecutar "${String(
        args.command || args.cmd || ""
      ).slice(0, 100)}".`;
    } else if (canonicalAction === "github.dispatch") {
      warningMsg = `Disparo de CI en GitHub (${String(args.workflow_id || "")}): requiere confirmación del operador.`;
    } else if (canonicalAction === "github.exec") {
      warningMsg = `Ejecución de comandos nativos de GitHub CLI (gh): requiere confirmación del operador.`;
    } else if (canonicalAction === "github.api") {
      warningMsg = `Invocación REST a GitHub API con potencial mutación (${String(args.method || "GET")}): requiere confirmación del operador.`;
    } else if (canonicalAction === "tui.spawn") {
      warningMsg = `Lanzamiento de TUI en modo '${String(args.mode)}': requiere confirmación del operador.`;
    }

    return {
      ok: false,
      action: canonicalAction,
      requires_confirmation: true,
      warning: warningMsg,
    };
  }

  try {
    const rawResult = await dispatchIsyMcpAction(canonicalAction, args);
    const sanitized = sanitizeOutput(rawResult.result);
    return {
      ok: rawResult.ok,
      action: canonicalAction,
      result: sanitized,
      error: rawResult.error,
    };
  } catch (err) {
    return {
      ok: false,
      action: canonicalAction,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
