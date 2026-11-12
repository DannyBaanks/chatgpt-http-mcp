// src/cli/commands/monitor.ts — `isymcp monitor ...` y `isymcp protocol`.
import { flag } from "../../cli/args";
import { MONITOR_PID, MONITOR_PORT, alive, monitorUp, readPid, startMonitorDetached, stopMonitor } from "../services";
import { status } from "./status";
import type { CliModule } from "../module";

export async function monitorCommand(sub: string | undefined, rest: string[]): Promise<void> {
  const { openBridgeMonitorStack } = await import("../../remote-monitor");
  const argsAll = [sub, ...rest].filter((a): a is string => Boolean(a));
  const port = Number(flag("--port", argsAll) ?? MONITOR_PORT);
  const ownerId = flag("--owner", argsAll) ?? (process.env.USER || "owner");

  if (!sub || sub === "status") {
    const up = await monitorUp(String(port));
    const pid = readPid(MONITOR_PID);
    const { db, monitor } = openBridgeMonitorStack();
    try {
      const tasks = monitor.listTasks(20);
      const activeLeases = db
        .query("SELECT lease_id, workspace_id, scopes_json, expires_at, absolute_deadline FROM leases WHERE revoked_at IS NULL AND expires_at > ?")
        .all(Date.now()) as any[];
      console.log(`monitor continuo: ${up ? "UP ✓ (corriendo sin cerrarse)" : "DOWN"} · http://127.0.0.1:${port} · pid=${pid && alive(pid) ? pid : "-"}`);
      console.log(`  leases activos: ${activeLeases.length}`);
      for (const l of activeLeases) {
        const minsLeft = Math.max(0, Math.round((Number(l.expires_at) - Date.now()) / 60_000));
        console.log(`    · ${l.lease_id} · ws=${l.workspace_id} · expira en ${minsLeft} min (${new Date(Number(l.expires_at)).toISOString()})`);
      }
      console.log(`  tareas recientes: ${tasks.length}`);
      for (const t of tasks.slice(0, 10)) {
        console.log(`    · ${t.task_id} [${t.state}] ws=${t.workspace_id} kind=${t.kind} attempts=${t.attempt_count} — ${t.description.slice(0, 60)}`);
      }
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "start") {
    const inboxOnly = argsAll.includes("--inbox-only");
    if (!(await startMonitorDetached(String(port), inboxOnly))) process.exitCode = 1;
    return;
  }

  if (sub === "stop") {
    stopMonitor();
    return;
  }

  if (sub === "run") {
    const intervalMs = Number(flag("--interval-ms", argsAll) ?? "500");
    const inboxOnly = argsAll.includes("--inbox-only");
    const { db, monitor, transport } = openBridgeMonitorStack();
    const server = transport.startLoopbackServer(port);
    const loop = inboxOnly
      ? null
      : monitor.startContinuousLoop({
          pollIntervalMs: intervalMs,
          onTaskCompleted: (task) => {
            console.log(
              `[${new Date().toISOString()}] [monitor] tarea procesada ${task.task_id} -> state=${task.state} (sigue esperando nuevas tareas...)`,
            );
          },
        });
    console.log(
      `[${new Date().toISOString()}] [monitor] demonio continuo activo en http://127.0.0.1:${server.port} (pid=${process.pid}, mode=${inboxOnly ? "inbox-only-wakeup" : `auto-worker:${intervalMs}ms`}). NO se cerrará hasta recibir SIGINT/SIGTERM o 'isymcp monitor stop'.`,
    );

    await new Promise<void>((resolve) => {
      const shutdown = (sig: string) => {
        console.log(`[${new Date().toISOString()}] [monitor] recibida señal ${sig}; deteniendo bucle continuo...`);
        loop?.stop();
        server.stop(true);
        db.close();
        resolve();
      };
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
    });
    return;
  }

  const consoleFlag = flag("--console", argsAll);
  const { hasAckTag } = await import("../../monitor/tasks");
  const waitNextUnackedTask = async (timeoutSec: number) => {
    const deadline = Date.now() + timeoutSec * 1000;
    console.error(`[monitor:wait-next] Escuchando nuevas tareas de ChatGPT por hasta ${timeoutSec}s para despertar a Argon...`);
    while (Date.now() < deadline) {
      const { db, monitor } = openBridgeMonitorStack();
      try {
        const tasks = monitor.listTasks(20);
        const unacked = tasks.find((t) => {
          // Aislamiento por consola: --console X solo ve tareas dirigidas a X; sin --console se ignoran las dirigidas.
          const targeted = t.conversation_ref.startsWith("console:");
          if (consoleFlag) { if (t.conversation_ref !== `console:${consoleFlag}`) return false; }
          else if (targeted) return false;
          if (t.state === "READY" || t.state === "AWAITING_APPROVAL") return true;
          if (t.state === "SUCCEEDED" && !hasAckTag(t.result?.output_summary)) {
            return true;
          }
          return false;
        });
        if (unacked) {
          const isAlert = unacked.kind === "system_alert" || unacked.kind === "github_alert";
          console.log(
            JSON.stringify(
              {
                wakeup: isAlert ? "MONITOR_ALERT_NOTIFICATION" : "NEW_CHATGPT_MONITOR_TASK",
                task_id: unacked.task_id,
                operation_id: unacked.operation_id,
                state: unacked.state,
                kind: unacked.kind,
                workspace_id: unacked.workspace_id,
                description: unacked.description,
                requested_actions: unacked.requested_actions,
                target_relpath: unacked.target_relpath,
                created_at: new Date(unacked.created_at).toISOString(),
              },
              null,
              2,
            ),
          );
          return;
        }
      } finally {
        db.close();
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(JSON.stringify({ wakeup: "TIMEOUT_NO_NEW_TASK", timeout_seconds: timeoutSec }));
  };

  if (sub === "wait-next") {
    const positionalSec = rest.find((a) => !a.startsWith("--"));
    const timeoutSec = Number(flag("--timeout-seconds", argsAll) ?? positionalSec ?? "3600");
    await waitNextUnackedTask(isNaN(timeoutSec) ? 3600 : timeoutSec);
    return;
  }

  if (sub === "ack" || (sub === "respond" && consoleFlag)) {
    const taskId = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--console" && rest[i - 1] !== "--summary" && rest[i - 1] !== "--pid");
    const consoleId = consoleFlag;
    const summaryText = flag("--summary", argsAll) ?? (sub === "ack" ? "Consola lista." : "Reporte de consola.");
    if (!consoleId) throw new Error("uso: isymcp monitor ack <task-id> --console <console-id> [--summary ...] (token en $ISYMCP_ACK_TOKEN o --token)");
    const token = flag("--token", argsAll) ?? process.env.ISYMCP_ACK_TOKEN ?? "";
    const pidArg = flag("--pid", argsAll);
    const kind = sub === "ack" ? "ack" : argsAll.includes("--complete") ? "complete" : argsAll.includes("--fail") ? "fail" : "progress";
    const { consoleReport } = await import("../../console-registry");
    const { db, workerSecret, env } = openBridgeMonitorStack();
    try {
      const rec = consoleReport(db, { consoleId, token, kind, summary: summaryText, pid: pidArg ? Number(pidArg) : undefined, hmacSecret: workerSecret }, env);
      if (taskId && taskId !== rec.task_id) throw new Error(`DENY: task_console_mismatch: la consola ${consoleId} pertenece a ${rec.task_id}, no a ${taskId}`);
      console.log(JSON.stringify({ ok: true, kind, console: rec }, null, 2));
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "consoles") {
    const { listConsoles } = await import("../../console-registry");
    const { db, env } = openBridgeMonitorStack();
    try {
      const rows = listConsoles(db, Number(flag("--limit", argsAll) ?? "20"), env);
      if (argsAll.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); return; }
      if (!rows.length) { console.log("sin consolas registradas"); return; }
      for (const c of rows) {
        console.log(`${c.console_id}\t${c.state}\tpid=${c.agent_pid ?? "-"}\talive=${c.alive ?? "?"}\ttask=${c.task_id}\ttoken_fp=${c.token_fp}\tevents=${c.events_count}\t${c.title}`);
      }
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "console-log") {
    const target = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--tail");
    if (!target) throw new Error("uso: isymcp monitor console-log <console-id|task-id> [--tail N]");
    const { readConsoleLog } = await import("../../console-registry");
    const { db } = openBridgeMonitorStack();
    try {
      console.log(JSON.stringify(readConsoleLog(db, target, Number(flag("--tail", argsAll) ?? "50")), null, 2));
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "respond") {
    const taskId = rest.find((a) => !a.startsWith("--"));
    const summaryText = flag("--summary", argsAll) ?? "Confirmado personalmente por Argon.";
    const autoWait = argsAll.includes("--wait") || argsAll.includes("--auto-wait");
    const timeoutSec = Number(flag("--timeout-seconds", argsAll) ?? "3600");
    if (!taskId) throw new Error('uso: isymcp monitor respond <task-id> --summary "respuesta de Argon" [--wait]');
    const { db, monitor } = openBridgeMonitorStack();
    try {
      const task = monitor.inspectTask(taskId);
      if (!task) throw new Error(`no existe la tarea: ${taskId}`);
      const { respondTask } = await import("../../monitor/tasks");
      respondTask(db, taskId, summaryText);
      console.log(JSON.stringify({ ok: true, mode: "updated_with_argon_ack", auto_wait_next: autoWait, task: monitor.inspectTask(taskId) }, null, 2));
    } finally {
      db.close();
    }

    if (autoWait) {
      await waitNextUnackedTask(timeoutSec);
    }
    return;
  }

  if (sub === "alert" || sub === "notify") {
    const title = flag("--title", argsAll) ?? "Alerta de sistema";
    const explicitSummary = flag("--summary", argsAll);
    const positionalSummary = rest.filter((a) => !a.startsWith("--")).join(" ");
    const summary = explicitSummary ?? (positionalSummary.length > 0 ? positionalSummary : "Notificación enviada al monitor");
    const source = flag("--source", argsAll) ?? "system";
    const { openBridgeMonitorStack } = await import("../../remote-monitor");
    const { db, queue } = openBridgeMonitorStack();
    try {
      const res = queue.submitAlertTask({ title, summary, source });
      console.log(JSON.stringify(res, null, 2));
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "tasks") {
    const { db, monitor } = openBridgeMonitorStack();
    try {
      const tasks = monitor.listTasks(50);
      if (argsAll.includes("--json")) {
        console.log(JSON.stringify(tasks, null, 2));
        return;
      }
      if (tasks.length === 0) {
        console.log("sin tareas en el buzón del monitor");
        return;
      }
      for (const t of tasks) {
        console.log(`${t.task_id}\t${t.state}\tws=${t.workspace_id}\tkind=${t.kind}\t${t.description}`);
        if (t.result) {
          console.log(`  ↳ resultado (exit=${t.result.exit_code}): ${t.result.output_summary}`);
        }
      }
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "approve") {
    const taskId = rest.find((a) => !a.startsWith("--"));
    if (!taskId) throw new Error("uso: isymcp monitor approve <task-id>");
    const { db, authority, monitor } = openBridgeMonitorStack();
    try {
      const task = monitor.inspectTask(taskId);
      if (!task) throw new Error(`no existe la tarea: ${taskId}`);
      const ogGrant = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["task:grant"] });
      const grant = authority.createTaskGrant(ogGrant, {
        workspace_id: task.workspace_id,
        allowed_kinds: [task.kind],
        allowed_actions: task.requested_actions.length > 0 ? task.requested_actions : ["tests:run"],
      });
      const ogApprove = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["task:grant"] });
      const updated = authority.authorizePendingTask(ogApprove, {
        task_id: taskId,
        grant_id: grant.grant_id,
      });
      console.log(`tarea aprobada: ${updated.task_id} -> state=${updated.state} (grant=${grant.grant_id})`);
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "lease") {
    const action = rest[0];
    const leaseArgs = rest.slice(1);
    const { db, authority } = openBridgeMonitorStack();
    try {
      if (action === "mint") {
        const wsId = flag("--workspace", leaseArgs) ?? "default-ws";
        const cwd = flag("--cwd", leaseArgs) ?? process.cwd();
        const ttlSeconds = Number(flag("--ttl-seconds", leaseArgs) ?? "7200");
        const autoGrant = leaseArgs.includes("--auto-grant");

        const ogWs = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["workspace:register"] });
        authority.registerWorkspace(ogWs, { workspace_id: wsId, root_path: cwd });

        const ogMint = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["lease:mint"] });
        const minted = authority.mintQueueLease(ogMint, {
          workspace_id: wsId,
          scopes: ["queue:submit", "queue:status"],
          ttlSeconds,
        });

        let autoGrantId: string | null = null;
        if (autoGrant) {
          const ogTaskGrant = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["task:grant"] });
          const tg = authority.createTaskGrant(ogTaskGrant, {
            workspace_id: wsId,
            allowed_kinds: ["verify_only", "review_and_test", "diagnostics"],
            allowed_actions: ["tests:run", "report:write", "status:read"],
            ttlSeconds,
          });
          autoGrantId = tg.grant_id;
        }

        console.log(`QueueLease emitido (tipo API-key por tiempo):`);
        console.log(`  token (turn_token): ${minted.token}`);
        console.log(`  lease_id:           ${minted.lease_id}`);
        console.log(`  workspace_id:       ${minted.workspace_id} (${cwd})`);
        console.log(`  scopes:             ${minted.scopes.join(", ")}`);
        console.log(`  expira:             ${new Date(minted.expires_at).toISOString()} (TTL=${ttlSeconds}s)`);
        console.log(`  tope absoluto:      ${new Date(minted.absolute_deadline).toISOString()}`);
        if (autoGrantId) {
          console.log(`  task_grant activo:  ${autoGrantId} (las tareas entrantes pasan directo a READY para el monitor continuo)`);
        }
        return;
      }

      if (action === "renew") {
        const leaseId = leaseArgs.find((a) => !a.startsWith("--"));
        const ttlSeconds = Number(flag("--ttl-seconds", leaseArgs) ?? "7200");
        if (!leaseId) throw new Error("uso: isymcp monitor lease renew <lease-id> --ttl-seconds <seg>");
        const ogRenew = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["lease:renew"] });
        const renewed = authority.renewQueueLease(ogRenew, {
          lease_id: leaseId,
          additionalTtlSeconds: ttlSeconds,
        });
        console.log(`QueueLease renovado: ${renewed.lease_id} · nueva expiracion=${new Date(renewed.expires_at).toISOString()} (gen=${renewed.generation})`);
        return;
      }

      if (action === "revoke") {
        const leaseId = leaseArgs.find((a) => !a.startsWith("--"));
        if (!leaseId) throw new Error("uso: isymcp monitor lease revoke <lease-id>");
        const ogRevoke = authority.mintOwnerGrant({ owner_id: ownerId, scopes: ["lease:revoke"] });
        const revoked = authority.revokeQueueLease(ogRevoke, leaseId);
        console.log(`QueueLease revocado inmediatamente: ${revoked.lease_id} (revoked_at=${new Date(revoked.revoked_at!).toISOString()})`);
        return;
      }
    } finally {
      db.close();
    }
    throw new Error("uso: isymcp monitor lease mint|renew|revoke ...");
  }

  throw new Error("uso: isymcp monitor start|stop|status|run|tasks|approve|lease|ack|consoles|console-log");
}

export const monitorModule: CliModule = { names: ["monitor"], run: (sub, rest) => monitorCommand(sub, rest) };

export const protocolModule: CliModule = {
  names: ["protocol", "agents"],
  async run() {
    const { ISYMCP_AGENT_PROTOCOL_MD } = await import("../../agent-protocol");
    console.log(ISYMCP_AGENT_PROTOCOL_MD);
  },
};
