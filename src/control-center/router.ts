// src/control-center/router.ts — Router API para el ISyMCP Control Center.
import {
  getControlCenterOverview,
  getControlCenterGlossary,
  getControlCenterTasks,
  approveControlCenterTask,
  dispatchControlCenterAction,
  getControlCenterProtocol,
  executeIsyMcpCli,
} from "./service";
import type { ControlCenterDispatchRequest, CliExecutionRequest } from "./contracts";

export async function handleControlCenterApi(
  req: Request,
  url: URL,
  bridgePort = "8791"
): Promise<Response> {
  const path = url.pathname;

  // 1. Overview / Health
  if (path === "/api/control-center/overview" && req.method === "GET") {
    const overview = await getControlCenterOverview(bridgePort);
    return Response.json(overview, {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // 2. Glosario / Catálogo de contratos tipados
  if (path === "/api/control-center/glossary" && req.method === "GET") {
    const glossary = getControlCenterGlossary();
    return Response.json(glossary, {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // 3. Tareas persistidas en SQLite WAL
  if (path === "/api/control-center/tasks" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") || "50");
    const tasks = getControlCenterTasks(limit);
    return Response.json({ ok: true, tasks }, {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // 4. Aprobación de tareas en AWAITING_APPROVAL (con verificación de workspace)
  if (path === "/api/control-center/tasks/approve" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { task_id?: unknown; workspace_id?: unknown } | null;
    const taskId = String(body?.task_id || "").trim();
    if (!taskId) {
      return Response.json({ ok: false, error: "task_id es requerido" }, { status: 400 });
    }
    const expectedWorkspaceId = typeof body?.workspace_id === "string" && body.workspace_id.trim()
      ? body.workspace_id.trim()
      : undefined;
    const result = approveControlCenterTask(taskId, expectedWorkspaceId);
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }

  // 5. Despacho seguro de acciones (con protocolo de OperatorGrant)
  if (path === "/api/control-center/dispatch" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as ControlCenterDispatchRequest | null;
    if (!body || !body.action) {
      return Response.json({ ok: false, error: "action es requerida" }, { status: 400 });
    }
    const result = await dispatchControlCenterAction(
      body.action,
      body.arguments || {},
      { confirmed: body.confirmed === true, operator_grant: body.operator_grant }
    );
    const status = result.requires_confirmation ? 403 : result.ok ? 200 : 400;
    return Response.json(result, { status });
  }

  // 6. Ejecución directa e interactiva de comandos CLI de isymcp (con OperatorGrant)
  if (path === "/api/control-center/cli" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as CliExecutionRequest | null;
    if (!body || !body.command) {
      return Response.json({ ok: false, error: "command es requerido" }, { status: 400 });
    }
    const result = await executeIsyMcpCli(
      body.command,
      body.args || [],
      {
        confirmed: body.confirmed === true,
        operator_grant: body.operator_grant,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
      }
    );
    const status = result.requires_confirmation ? 403 : result.ok ? 200 : 500;
    return Response.json(result, {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // 7. Protocolo de agentes
  if (path === "/api/control-center/protocol" && req.method === "GET") {
    const md = getControlCenterProtocol();
    return new Response(md, {
      headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
    });
  }

  return Response.json({ error: { type: "not_found", message: `Ruta desconocida: ${path}` } }, { status: 404 });
}
