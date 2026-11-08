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
  CliExecutionRequest,
  CliExecutionResult,
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
  consoles: "tui.consoles",
  "console-log": "tui.log",
  console_log: "tui.log",
};

function sanitizeOutput(data: unknown): unknown {
  if (typeof data === "string") {
    // Redactar tokens, secrets y rutas sensibles
    return data
      .replace(/(ghp_[A-Za-z0-9_]{36,})/g, "[REDACTED_GH_TOKEN]")
      .replace(/(x-isymcp-token:\s*)[^\s\r\n]+/gi, "$1[REDACTED]")
      .replace(/(ql_[A-Za-z0-9_-]{20,})/g, "[REDACTED_LEASE_TOKEN]")
      .replace(/(ctk_[A-Za-z0-9_-]{20,})/g, "[REDACTED_CONSOLE_TOKEN]")
      .replace(/(og-[A-Za-z0-9_-]{16,})/g, "[REDACTED_OWNER_GRANT]")
      .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
      .replace(/(\.codex-web-http\/storage-state\.json)/g, "[REDACTED_STORAGE_PATH]")
      .replace(/(\.codex-web-http\/token)/g, "[REDACTED_TOKEN_PATH]");
  }
  if (Array.isArray(data)) {
    return data.map(sanitizeOutput);
  }
  if (data !== null && typeof data === "object") {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (/token|secret|password|key|cookie|session_id|auth_header|worker_secret|turn_token|storage_state/i.test(k)) {
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
        .query("SELECT COUNT(*) as count FROM leases WHERE revoked_at IS NULL AND expires_at > ?")
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

export function approveControlCenterTask(
  taskId: string,
  expectedWorkspaceId?: string,
  env: Record<string, string | undefined> = process.env
): { ok: boolean; task?: unknown; error?: string } {
  if (!taskId || typeof taskId !== "string") {
    return { ok: false, error: "task_id inválido o requerido" };
  }
  const { db, authority, monitor } = openBridgeMonitorStack(env);
  try {
    const task = monitor.inspectTask(taskId);
    if (!task) return { ok: false, error: `No existe la tarea: ${taskId}` };
    if (expectedWorkspaceId && task.workspace_id !== expectedWorkspaceId) {
      return {
        ok: false,
        error: `DENY: workspace_mismatch: tarea pertenece a '${task.workspace_id}', pero se esperaba '${expectedWorkspaceId}'`,
      };
    }
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
  options: { confirmed?: boolean; operator_grant?: unknown } = {}
): Promise<ControlCenterDispatchResponse> {
  const normAction = (action || "").trim().toLowerCase();
  const canonicalAction = ACTION_ALIAS_MAP[normAction] ?? normAction;

  // Comprobar si es un comando peligroso
  const isDangerous =
    DANGEROUS_ACTIONS.has(canonicalAction) ||
    (canonicalAction === "tui.spawn" &&
      (args.mode === "accept-edits" || args.dangerously_skip_permissions === true));

  if (isDangerous) {
    let warningMsg = "Esta acción puede modificar el sistema, ejecutar código en el host o alterar repositorios.";
    if (canonicalAction === "shell.exec") {
      warningMsg = `Ejecución de shell arbitraria: se requiere confirmación explícita con grant firmado para ejecutar "${String(
        args.command || args.cmd || ""
      ).slice(0, 100)}".`;
    } else if (canonicalAction === "github.dispatch") {
      warningMsg = `Disparo de CI en GitHub (${String(args.workflow_id || "")}): requiere autorización de operador con grant firmado.`;
    } else if (canonicalAction === "github.exec") {
      warningMsg = `Ejecución de comandos nativos de GitHub CLI (gh): requiere autorización de operador con grant firmado.`;
    } else if (canonicalAction === "github.api") {
      warningMsg = `Invocación REST a GitHub API con potencial mutación (${String(args.method || "GET")}): requiere autorización de operador con grant firmado.`;
    } else if (canonicalAction === "tui.spawn") {
      warningMsg = `Lanzamiento de TUI en modo '${String(args.mode)}': requiere autorización de operador con grant firmado.`;
    }

    // Protocolo de Autoridad Criptográfica: Si no se provee operator_grant, emitir challenge
    if (!options.operator_grant) {
      const { db, authority } = openBridgeMonitorStack();
      let grant: unknown = null;
      try {
        grant = authority.mintOwnerGrant({
          owner_id: "operator_local",
          scopes: ["operator:confirm"],
          ttlSeconds: 60,
        });
      } finally {
        db.close();
      }
      return {
        ok: false,
        action: canonicalAction,
        requires_confirmation: true,
        warning: warningMsg,
        operator_grant: grant,
      };
    }

    // Si se envía operator_grant, consumirlo con validación estricta de un solo uso
    const { db, authority } = openBridgeMonitorStack();
    try {
      authority.consumeOwnerGrant(options.operator_grant, "operator:confirm");
    } catch (err) {
      return {
        ok: false,
        action: canonicalAction,
        requires_confirmation: true,
        warning: `DENY: Autorización de operador inválida o consumida (${err instanceof Error ? err.message : String(err)})`,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      db.close();
    }
  }

  try {
    // El OperatorGrant ya fue consumido arriba (un solo uso): este contexto
    // async queda autorizado para que el gate de shell/executor lo honre.
    const { runWithHostShellAuthorization } = await import("../shell/executor");
    const rawResult = await runWithHostShellAuthorization(() => dispatchIsyMcpAction(canonicalAction, args));
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

export function isCliCommandDestructive(
  base: string,
  args: string[] = []
): { isDestructive: boolean; warning?: string } {
  const normBase = (base || "").trim().toLowerCase();
  const lowerArgs = args.map((a) => (a || "").trim().toLowerCase());

  if (normBase === "down") {
    return {
      isDestructive: true,
      warning: "Detener todos los servicios (server + túnel) interrumpirá la conectividad con ChatGPT.",
    };
  }
  if (normBase === "server" && lowerArgs.includes("stop")) {
    return {
      isDestructive: true,
      warning: "Detener el Codex Bridge Server (:8791) interrumpirá las peticiones de ChatGPT.",
    };
  }
  if (normBase === "tunnel" && lowerArgs.includes("stop")) {
    return {
      isDestructive: true,
      warning: "Detener el túnel Cloudflare desconectará la URL pública de OpenAI.",
    };
  }
  if (normBase === "exec" || normBase === "sh") {
    return {
      isDestructive: true,
      warning: `Ejecución de shell arbitraria: "${args.join(" ").slice(0, 80)}" se ejecutará directamente en el host.`,
    };
  }
  if (normBase === "tui" && lowerArgs.includes("spawn") && lowerArgs.includes("accept-edits")) {
    return {
      isDestructive: true,
      warning: "El modo accept-edits permite a la TUI editar archivos sin confirmación interactiva.",
    };
  }
  if (normBase === "tui" && lowerArgs.includes("install") && lowerArgs.includes("--apply")) {
    return {
      isDestructive: true,
      warning: "Instalar MCP en configs de TUIs modificará archivos de configuración locales.",
    };
  }
  if (normBase === "models" && lowerArgs.includes("restore")) {
    return {
      isDestructive: true,
      warning: "Restaurar modelos revertirá configuraciones de perfiles de Codex.",
    };
  }
  if (normBase === "session" && lowerArgs.includes("revoke")) {
    return {
      isDestructive: true,
      warning: "Revocar sesiones invalidará tokens y credenciales activas.",
    };
  }

  return { isDestructive: false };
}

export async function executeIsyMcpCli(
  command: string,
  args: string[] = [],
  options: { confirmed?: boolean; operator_grant?: unknown; cwd?: string; timeoutMs?: number } = {}
): Promise<CliExecutionResult> {
  const trimmed = (command || "").trim();
  if (!trimmed) {
    return {
      ok: false,
      command: "",
      full_command: "isymcp",
      stdout: "",
      stderr: "Comando CLI vacío o requerido",
      exit_code: 1,
      duration_ms: 0,
      error: "Comando CLI requerido",
    };
  }

  let base = trimmed;
  let cmdArgs = [...args];
  if (cmdArgs.length === 0 && /\s/.test(trimmed)) {
    const matches = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    if (matches.length > 0) {
      base = matches[0].replace(/^["']|["']$/g, "");
      cmdArgs = matches.slice(1).map((m) => m.replace(/^["']|["']$/g, ""));
    }
  }

  if (base.toLowerCase() === "isymcp" && cmdArgs.length > 0) {
    base = cmdArgs[0];
    cmdArgs = cmdArgs.slice(1);
  }

  const fullCommand = `isymcp ${[base, ...cmdArgs].join(" ")}`.trim();
  const check = isCliCommandDestructive(base, cmdArgs);

  if (check.isDestructive) {
    if (!options.operator_grant) {
      const { db, authority } = openBridgeMonitorStack();
      let grant: unknown = null;
      try {
        grant = authority.mintOwnerGrant({
          owner_id: "operator_local",
          scopes: ["operator:confirm"],
          ttlSeconds: 60,
        });
      } finally {
        db.close();
      }
      return {
        ok: false,
        command: base,
        full_command: fullCommand,
        stdout: "",
        stderr: `Bloqueado por seguridad: ${check.warning}`,
        exit_code: 1,
        duration_ms: 0,
        requires_confirmation: true,
        warning: check.warning,
        operator_grant: grant,
      };
    }

    const { db, authority } = openBridgeMonitorStack();
    try {
      authority.consumeOwnerGrant(options.operator_grant, "operator:confirm");
    } catch (err) {
      return {
        ok: false,
        command: base,
        full_command: fullCommand,
        stdout: "",
        stderr: `DENY: Autorización de operador inválida o consumida (${err instanceof Error ? err.message : String(err)})`,
        exit_code: 1,
        duration_ms: 0,
        requires_confirmation: true,
        warning: `DENY: Autorización denegada (${err instanceof Error ? err.message : String(err)})`,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      db.close();
    }
  }

  const isyCliPath = join(import.meta.dir, "..", "isymcp.ts");
  const repoRoot = join(import.meta.dir, "..", "..");
  const timeout = options.timeoutMs ?? 35_000;
  const start = performance.now();

  try {
    const proc = Bun.spawnSync(["bun", "run", isyCliPath, base, ...cmdArgs], {
      cwd: options.cwd || repoRoot,
      timeout,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const duration_ms = Math.round(performance.now() - start);
    const rawOut = proc.stdout ? proc.stdout.toString() : "";
    const rawErr = proc.stderr ? proc.stderr.toString() : "";
    const cleanOut = String(sanitizeOutput(rawOut));
    const cleanErr = String(sanitizeOutput(rawErr));
    const exit_code = typeof proc.exitCode === "number" ? proc.exitCode : 0;

    return {
      ok: exit_code === 0,
      command: base,
      full_command: fullCommand,
      stdout: cleanOut,
      stderr: cleanErr,
      exit_code,
      duration_ms,
      error: exit_code !== 0 && !cleanErr ? `Proceso terminó con exit code ${exit_code}` : undefined,
    };
  } catch (err) {
    const duration_ms = Math.round(performance.now() - start);
    return {
      ok: false,
      command: base,
      full_command: fullCommand,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exit_code: 1,
      duration_ms,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
