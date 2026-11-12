// src/monitor/transport.ts — MonitorRemoteTransport: superficie HTTP/MCP del monitor (loopback, guard local).
// (Movido sin cambios desde src/remote-monitor.ts, 2026-11-12.)
import { guardLocalRequest } from "../local-guard";
import { LeaseAuthority } from "./authority";
import { QueueService } from "./queue";
import { QueueTaskSubmission } from "./types";

/**
 * Adaptador de Transporte Remoto Autenticado de ISyMCP (HTTP Loopback + MCP Tool Dispatcher).
 * - Permite que un turno remoto con un `queue_lease` válido encole tareas (`POST /isymcp/monitor/submit`
 *   o tool `monitor_queue_submit`) y consulte estados (`GET /isymcp/monitor/status/:taskId` o tool `monitor_queue_status`).
 * - Rechaza de forma determinista cualquier intento de usar el transporte o un `queue_lease` para
 *   invocar herramientas de ejecución (`codex_exec`, `codex_apply_patch`, `POST /isymcp/monitor/exec`).
 */
export class MonitorRemoteTransport {
  private readonly queue: QueueService;
  private readonly authority: LeaseAuthority;

  constructor(queue: QueueService, authority: LeaseAuthority) {
    this.queue = queue;
    this.authority = authority;
  }

  /**
   * Despacha llamadas de herramientas MCP expuestas al conector remoto.
   */
  public dispatchMcpTool(
    toolName: string,
    args: Record<string, unknown>,
  ): { isError: boolean; payload: unknown } {
    if (
      toolName === "codex_exec" ||
      toolName === "codex_apply_patch" ||
      toolName === "codex_write_stdin" ||
      toolName === "codex_view_image" ||
      toolName === "exec_command" ||
      toolName === "apply_patch" ||
      toolName === "write_stdin" ||
      toolName === "view_image" ||
      toolName === "monitor_exec"
    ) {
      return {
        isError: true,
        payload: {
          accepted: false,
          state: "DENIED",
          reason: "DENY: queue_lease_cannot_execute",
        },
      };
    }

    if (toolName === "monitor_queue_submit") {
      const submission = args as unknown as QueueTaskSubmission;
      const res = this.queue.submitTask(submission);
      return {
        isError: !res.accepted,
        payload: res,
      };
    }

    if (toolName === "monitor_queue_status") {
      try {
        const leaseToken = String(args.lease_token ?? "");
        const taskId = String(args.task_id ?? "");
        const rec = this.queue.getTaskStatus(leaseToken, taskId);
        return {
          isError: false,
          payload: {
            task_id: rec.task_id,
            operation_id: rec.operation_id,
            state: rec.state,
            reason: rec.reason,
            attempt_count: rec.attempt_count,
            result: rec.result,
          },
        };
      } catch (err: any) {
        return {
          isError: true,
          payload: {
            accepted: false,
            state: "DENIED",
            reason: String(err?.message ?? err),
          },
        };
      }
    }

    return {
      isError: true,
      payload: {
        accepted: false,
        state: "DENIED",
        reason: `DENY: unknown_monitor_tool:${toolName}`,
      },
    };
  }

  /**
   * Manejador HTTP autenticado por Bearer token (`queue_lease`) para el bridge local.
   */
  public async handleHttpRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Misma guarda que el resto de superficies locales: Host loopback, Origin
    // permitido y POST application/json. Sin esto, una pagina web podria hacer
    // POST simple (CSRF) al submit del monitor.
    const denied = guardLocalRequest(req, { requireJsonBody: true });
    if (denied) return denied;
    if (req.method === "GET" && url.pathname === "/ready") {
      return Response.json({ ok: true, service: "isymcp-remote-monitor", pid: process.pid }, { status: 200 });
    }
    const authHeader = req.headers.get("authorization") ?? "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

    if (url.pathname === "/isymcp/monitor/exec") {
      return Response.json(
        {
          accepted: false,
          state: "DENIED",
          reason: "DENY: queue_lease_cannot_execute",
        },
        { status: 403 },
      );
    }

    if (req.method === "POST" && (url.pathname === "/isymcp/monitor/alert" || url.pathname === "/isymcp/monitor/webhook/github")) {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { accepted: false, state: "DENIED", reason: "invalid_json_body" },
          { status: 400 },
        );
      }

      if (url.pathname === "/isymcp/monitor/webhook/github") {
        const ghEvent = req.headers.get("x-github-event") || "workflow_run";
        const workflowRun = (body.workflow_run || body) as Record<string, any>;
        const repoName = (body.repository as any)?.full_name || "repository";
        const workflowName = workflowRun.name || "CI";
        const conclusion = workflowRun.conclusion || workflowRun.status || "completed";
        const branch = workflowRun.head_branch || "main";
        const runId = workflowRun.id || "unknown";
        const htmlUrl = workflowRun.html_url || "";

        const alertRes = this.queue.submitAlertTask({
          source: "github",
          event: ghEvent,
          title: `GitHub CI [${repoName}]`,
          summary: `Workflow '${workflowName}' #${runId} on ${branch} finished: ${conclusion}`,
          metadata: { repo: repoName, workflow: workflowName, run_id: runId, conclusion, branch, url: htmlUrl },
        });
        return Response.json(alertRes, { status: 200 });
      }

      const alertRes = this.queue.submitAlertTask({
        source: typeof body.source === "string" ? body.source : "system",
        event: typeof body.event === "string" ? body.event : "alert",
        title: typeof body.title === "string" ? body.title : "Notificación del Monitor",
        summary: typeof body.summary === "string" ? body.summary : String(body.message || ""),
        metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {},
      });
      return Response.json(alertRes, { status: 200 });
    }

    if (req.method === "POST" && url.pathname === "/isymcp/monitor/submit") {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { accepted: false, state: "DENIED", reason: "invalid_json_body" },
          { status: 400 },
        );
      }
      const submission: QueueTaskSubmission = {
        ...(body as unknown as QueueTaskSubmission),
        lease_token: bearerToken || String(body.lease_token ?? ""),
      };
      const res = this.queue.submitTask(submission);
      return Response.json(res, { status: res.accepted ? 200 : 403 });
    }

    if (req.method === "GET" && url.pathname.startsWith("/isymcp/monitor/status/")) {
      const taskId = url.pathname.slice("/isymcp/monitor/status/".length).trim();
      try {
        const rec = this.queue.getTaskStatus(bearerToken, taskId);
        return Response.json(
          {
            task_id: rec.task_id,
            operation_id: rec.operation_id,
            state: rec.state,
            reason: rec.reason,
            attempt_count: rec.attempt_count,
            result: rec.result,
          },
          { status: 200 },
        );
      } catch (err: any) {
        return Response.json(
          {
            accepted: false,
            state: "DENIED",
            reason: String(err?.message ?? err),
          },
          { status: 403 },
        );
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  /**
   * Inicia un servidor HTTP en loopback (127.0.0.1) para pruebas E2E o ejecución del bridge local.
   */
  public startLoopbackServer(port = 0) {
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (req) => this.handleHttpRequest(req),
    });
  }
}

export function isQueueLeaseToken(token: unknown): token is string {
  return typeof token === "string" && token.startsWith("ql_") && token.length >= 20;
}
