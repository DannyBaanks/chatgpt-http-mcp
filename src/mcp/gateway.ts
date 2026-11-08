// src/mcp/gateway.ts — Universal Gateway y Glosario de Herramientas para ISyMCP estilo REA.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawnAgyTui } from "../tui-launcher";
import { GITHUB_MCP_TOOLS } from "../github/mcp-tools";
import { callGitHubApi } from "../github/client";
import { openBridgeMonitorStack } from "../remote-monitor";
import { ISYMCP_AGENT_PROTOCOL_MD } from "../agent-protocol";
import { executeShellCommand } from "../shell/executor";

export interface GlossaryEntry {
  description: string;
  parameters: Record<string, string>;
  example?: Record<string, unknown>;
}

export interface GlossaryFamily {
  description: string;
  actions: Record<string, GlossaryEntry>;
}

export const ISYMCP_GLOSSARY: {
  isymcp_version: string;
  gateway: string;
  description: string;
  usage_instruction: string;
  families: Record<string, GlossaryFamily>;
} = {
  isymcp_version: "1.1.0",
  gateway: "isymcp",
  description: "Glosario oficial de capacidades de ISyMCP (Universal Gateway estilo REA).",
  usage_instruction:
    "Para invocar cualquier herramienta usa: isymcp(action='<familia>.<accion>', arguments={...}). Para ver este glosario usa: isymcp(action='glossary').",
  families: {
    tui: {
      description: "Orquestación y despliegue de consolas interactivas Antigravity (AGY) en el escritorio local.",
      actions: {
        "tui.spawn": {
          description:
            "Abre una consola TUI de Antigravity en una ventana visible (gnome-terminal/tmux) con auto-registro de tarea y enlace al bus del monitor.",
          parameters: {
            prompt: "string (obligatorio: instrucción o tarea para el nuevo agente)",
            mode: "enum: 'plan' | 'auto' | 'accept-edits' (por defecto 'auto')",
            title: "string (opcional: título de la ventana)",
            terminal: "enum: 'auto' | 'gui' | 'tmux' (por defecto 'auto')",
            dangerously_skip_permissions: "boolean (por defecto false para seguridad)",
            task_id: "string (opcional: ID de tarea para vincular con el monitor, auto-generado si se omite)",
            operation_id: "string (opcional: ID de operación asociada)",
          },
          example: {
            action: "tui.spawn",
            arguments: {
              prompt: "Auditar arquitectura y pruebas en modo seguro",
              mode: "plan",
            },
          },
        },
      },
    },

    github: {
      description: "Operaciones autenticadas con GitHub mediante el token PAT de Danny (DannyBaanks) almacenado en ISyMCP.",
      actions: {
        "github.status": {
          description: "Consulta el estado del token activo, scopes, cuota de rate-limit y usuario autenticado.",
          parameters: {},
          example: { action: "github.status" },
        },
        "github.whoami": {
          description: "Perfil detallado de la cuenta autenticada y organizaciones asociadas.",
          parameters: {},
          example: { action: "github.whoami" },
        },
        "github.repos": {
          description: "Lista repositorios del usuario u organización.",
          parameters: {
            user: "string (opcional: si se omite lista los del usuario autenticado)",
          },
          example: { action: "github.repos", arguments: { user: "DannyBaanks" } },
        },
        "github.prs": {
          description: "Lista pull requests de un repositorio.",
          parameters: {
            owner: "string (dueño del repositorio)",
            repo: "string (nombre del repositorio)",
            state: "enum: 'open' | 'closed' | 'all' (por defecto 'open')",
          },
          example: { action: "github.prs", arguments: { owner: "DannyBaanks", repo: "chatgpt-http-mcp", state: "open" } },
        },
        "github.issues": {
          description: "Lista issues de un repositorio.",
          parameters: {
            owner: "string (dueño)",
            repo: "string (nombre del repo)",
            state: "enum: 'open' | 'closed' | 'all' (por defecto 'open')",
          },
          example: { action: "github.issues", arguments: { owner: "DannyBaanks", repo: "chatgpt-http-mcp" } },
        },
        "github.api": {
          description: "Ejecuta cualquier llamada REST v3 o GraphQL oficial de GitHub con el token activo.",
          parameters: {
            endpoint: "string (ej. '/user', '/repos/DannyBaanks/WINS')",
            method: "enum: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' (por defecto 'GET')",
            params: "record (parámetros querystring opcionales)",
            body: "record (cuerpo JSON para POST/PATCH)",
          },
          example: { action: "github.api", arguments: { endpoint: "/repos/DannyBaanks/WINS" } },
        },
        "github.dispatch": {
          description: "Dispara un flujo de trabajo (workflow_dispatch) de GitHub Actions.",
          parameters: {
            owner: "string (dueño)",
            repo: "string (repositorio)",
            workflow_id: "string (ej. ci.yml)",
            ref: "string (rama o tag, por defecto 'main')",
            inputs: "record (parámetros de entrada del workflow)",
          },
          example: {
            action: "github.dispatch",
            arguments: { owner: "DannyBaanks", repo: "chatgpt-http-mcp", workflow_id: "ci.yml", ref: "main" },
          },
        },
        "github.exec": {
          description: "Ejecuta comandos CLI nativos de GitHub (gh).",
          parameters: {
            args: "array de strings con los argumentos para gh (ej. ['pr', 'list'])",
          },
          example: { action: "github.exec", arguments: { args: ["pr", "list", "--state", "open"] } },
        },
      },
    },

    monitor: {
      description: "Coordinación asíncrona, colas de tareas con SQLite WAL y recibos criptográficos HMAC.",
      actions: {
        "monitor.status": {
          description: "Consulta el estado del demonio del monitor, leases activos y tareas recientes.",
          parameters: {},
          example: { action: "monitor.status" },
        },
        "monitor.tasks": {
          description: "Lista las tareas registradas en la cola del monitor con sus estados y recibos.",
          parameters: {
            limit: "number (opcional, por defecto 20)",
          },
          example: { action: "monitor.tasks", arguments: { limit: 10 } },
        },
        "monitor.submit": {
          description: "Encola una tarea estructurada para ejecución o supervisión.",
          parameters: {
            operation_id: "string",
            kind: "string (ej. 'diagnostics', 'review_and_test')",
            description: "string",
            requested_actions: "array de strings (ej. ['status:read', 'tests:run', 'report:write'])",
          },
          example: {
            action: "monitor.submit",
            arguments: {
              operation_id: "op-check-001",
              kind: "diagnostics",
              description: "Verificar integridad del monitor",
              requested_actions: ["status:read"],
            },
          },
        },
        "monitor.respond": {
          description: "Envía un reporte de avance o ACK a una tarea con recibo firmado.",
          parameters: {
            task_id: "string (ID de la tarea a responder)",
            summary: "string (texto del reporte o veredicto)",
          },
          example: {
            action: "monitor.respond",
            arguments: {
              task_id: "task-tui-12345",
              summary: "Tarea completada exitosamente.",
            },
          },
        },
      },
    },

    media: {
      description: "Análisis técnico y preparación de archivos de audio y video locales sin salir de la máquina.",
      actions: {
        "media.list": {
          description: "Lista los activos multimedia registrados en el inventario local.",
          parameters: {},
        },
        "media.info": {
          description: "Obtiene metadatos técnicos, codecs y streams de un activo registrado.",
          parameters: { asset_id: "string" },
        },
        "media.lookup": {
          description: "Comprueba si una URL de YouTube o video ya está preparada localmente.",
          parameters: { url: "string" },
        },
      },
    },

    comfyui: {
      description: "Generación de imágenes y workflows locales con ComfyUI.",
      actions: {
        "comfyui.status": {
          description: "Estado de salud del servicio ComfyUI en loopback.",
          parameters: {},
        },
        "comfyui.workflows": {
          description: "Catálogo de workflows disponibles en el entorno local.",
          parameters: {},
        },
        "comfyui.generate": {
          description: "Encola la generación de una imagen en un workflow específico.",
          parameters: {
            workflow_id: "string",
            inputs: "record",
          },
        },
      },
    },

    protocol: {
      description: "Protocolo oficial de bootstrap, persistencia y ciclo de vida para agentes interactivos.",
      actions: {
        "protocol.read": {
          description: "Retorna el documento Markdown con las instrucciones de inicialización y comandos de persistencia (/task) para agentes coordinados por ChatGPT.",
          parameters: {},
          example: { action: "protocol.read" },
        },
      },
    },

    shell: {
      description: "Ejecución directa de comandos shell/bash en la máquina de Danny con persistencia de directorio de trabajo (cwd).",
      actions: {
        "shell.exec": {
          description: "Ejecuta un comando arbitrario en bash con soporte para cwd persistente, navegación con 'cd <ruta>', variables de entorno y piping.",
          parameters: {
            command: "string (obligatorio: comando bash a ejecutar)",
            cwd: "string (opcional: directorio de trabajo inicial)",
            timeout_ms: "number (opcional: tiempo límite en ms, por defecto 30000)",
          },
          example: {
            action: "shell.exec",
            arguments: { command: "git status" },
          },
        },
      },
    },

    fuzz: {
      description: "Suite de pruebas adversariales y fuzzing para configs de TUIs y Universal Gateway.",
      actions: {
        "fuzz.run": {
          description: "Ejecuta pruebas sintácticas y semánticas intensivas contra el instalador TUI y el despachador de herramientas.",
          parameters: {
            iterations: "number (opcional: iteraciones por suite, por defecto 50)",
          },
          example: {
            action: "fuzz.run",
            arguments: { iterations: 25 },
          },
        },
      },
    },
  },
};

/**
 * Despachador universal de acciones para ISyMCP.
 */
export async function dispatchIsyMcpAction(
  action: string | undefined,
  args: Record<string, any> = {},
): Promise<{ ok: boolean; result: unknown; error?: string }> {
  const normalized = (typeof action === "string" ? action : String(action ?? "")).trim().toLowerCase();
  const safeArgs: Record<string, any> = (args && typeof args === "object" && !Array.isArray(args)) ? args : {};
  args = safeArgs;

  // 1. Glosario / Catálogo / Ayuda
  if (!normalized || normalized === "glossary" || normalized === "catalog" || normalized === "help") {
    return {
      ok: true,
      result: ISYMCP_GLOSSARY,
    };
  }

  // 2. Describe: Devuelve el contrato de una acción específica
  if (normalized === "describe") {
    const rawTarget = String(args.name ?? args.action ?? "").trim().toLowerCase();
    const aliasMap: Record<string, string> = {
      shell: "shell.exec",
      exec: "shell.exec",
      bash: "shell.exec",
      cmd: "shell.exec",
      tui: "tui.spawn",
      spawn: "tui.spawn",
      protocol: "protocol.read",
      agents: "protocol.read",
      fuzz: "fuzz.run",
      status: "monitor.status",
      tasks: "monitor.tasks",
      respond: "monitor.respond",
      submit: "monitor.submit",
    };
    const targetName = aliasMap[rawTarget] ?? rawTarget;
    for (const [familyName, family] of Object.entries(ISYMCP_GLOSSARY.families)) {
      if (family.actions[targetName]) {
        return {
          ok: true,
          result: {
            action: targetName,
            family: familyName,
            ...family.actions[targetName],
          },
        };
      }
    }
    return {
      ok: false,
      result: null,
      error: `Acción desconocida en el glosario: '${rawTarget}'. Invoca isymcp(action='glossary') para ver la lista completa.`,
    };
  }

  try {
    // 3. Familia TUI
    if (normalized === "tui.spawn" || normalized === "spawn" || normalized === "tui") {
      const res = await spawnAgyTui({
        prompt: String(args.prompt ?? "Hola Danny, consola coordinada por ISyMCP"),
        cwd: args.cwd ? String(args.cwd) : undefined,
        title: args.title ? String(args.title) : undefined,
        mode: args.mode as any,
        terminalPreference: args.terminal as any,
        dangerouslySkipPermissions: args.dangerously_skip_permissions === true,
        includeMonitorHint: args.include_monitor_hint !== false,
        dryRun: args.dryRun === true || args.dry_run === true,
        taskId: args.task_id ? String(args.task_id) : undefined,
        operationId: args.operation_id ? String(args.operation_id) : undefined,
      });
      return { ok: res.ok, result: res, error: res.error };
    }

    // 4. Familia GitHub
    if (normalized === "github.status") {
      const res = await GITHUB_MCP_TOOLS.github_status.handler();
      return { ok: true, result: res };
    }

    if (normalized === "github.whoami") {
      const res = await callGitHubApi("/user");
      return { ok: res.ok, result: res.data, error: res.error };
    }

    if (normalized === "github.repos") {
      const user = args.user ? String(args.user) : undefined;
      const endpoint = user ? `/users/${user}/repos` : "/user/repos";
      const res = await callGitHubApi(endpoint);
      return { ok: res.ok, result: res.data, error: res.error };
    }

    if (normalized === "github.prs") {
      const owner = String(args.owner ?? "");
      const repo = String(args.repo ?? "");
      if (!owner || !repo) throw new Error("github.prs requiere owner y repo");
      const state = String(args.state ?? "open");
      const res = await callGitHubApi(`/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}`);
      return { ok: res.ok, result: res.data, error: res.error };
    }

    if (normalized === "github.issues") {
      const owner = String(args.owner ?? "");
      const repo = String(args.repo ?? "");
      if (!owner || !repo) throw new Error("github.issues requiere owner y repo");
      const state = String(args.state ?? "open");
      const res = await callGitHubApi(`/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}`);
      return { ok: res.ok, result: res.data, error: res.error };
    }

    if (normalized === "github.api") {
      const res = await GITHUB_MCP_TOOLS.github_api.handler({
        endpoint: String(args.endpoint ?? "/user"),
        method: args.method as any,
        params: args.params,
        body: args.body,
      });
      return { ok: res.ok, result: res.data ?? res, error: res.error };
    }

    if (normalized === "github.dispatch") {
      const res = await GITHUB_MCP_TOOLS.github_dispatch_workflow.handler({
        owner: String(args.owner ?? ""),
        repo: String(args.repo ?? ""),
        workflow_id: String(args.workflow_id ?? "ci.yml"),
        ref: args.ref ? String(args.ref) : "main",
        inputs: args.inputs,
      });
      return { ok: res.ok, result: res, error: res.error };
    }

    if (normalized === "github.exec") {
      const res = await GITHUB_MCP_TOOLS.github_exec.handler({
        args: Array.isArray(args.args) ? args.args.map(String) : [],
      });
      return { ok: res.ok, result: res };
    }

    // 5. Familia Monitor
    if (normalized === "monitor.status") {
      const { db, monitor } = openBridgeMonitorStack();
      try {
        const tasks = monitor.listTasks(10);
        const leases = db.query("SELECT * FROM leases WHERE revoked_at IS NULL").all();
        return {
          ok: true,
          result: {
            monitor_url: process.env.ISYMCP_MONITOR_URL || "http://127.0.0.1:8799",
            active_leases_count: leases.length,
            recent_tasks_count: tasks.length,
            recent_tasks: tasks.map((t) => ({
              task_id: t.task_id,
              state: t.state,
              kind: t.kind,
              description: t.description.slice(0, 100),
            })),
          },
        };
      } finally {
        db.close();
      }
    }

    if (normalized === "monitor.tasks") {
      const { db, monitor } = openBridgeMonitorStack();
      try {
        const limit = Number(args.limit ?? 20);
        const tasks = monitor.listTasks(limit);
        return { ok: true, result: tasks };
      } finally {
        db.close();
      }
    }

    if (normalized === "monitor.submit") {
      const taskId = String(args.task_id ?? `task-mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
      const operationId = String(args.operation_id ?? `op-${Date.now().toString(36)}`);
      const kind = String(args.kind ?? "generic");
      const description = String(args.description ?? "");
      if (!description) {
        return { ok: false, result: null, error: "monitor.submit requiere 'description'" };
      }
      const requestedActions = Array.isArray(args.requested_actions) ? args.requested_actions.map(String) : ["status:read"];
      const { openBridgeMonitorStack } = await import("../remote-monitor");
      const { db, monitor } = openBridgeMonitorStack();
      try {
        const now = Date.now();
        db.query(`
          INSERT INTO tasks (
            task_id, operation_id, idempotency_key, goal_id, conversation_ref,
            lease_id, workspace_id, kind, description, requested_actions_json,
            target_relpath, idempotent, state, reason, grant_id, worker_lease_id,
            attempt_count, created_at, updated_at, result_json, receipt_hmac
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          operationId,
          String(args.idempotency_key ?? `idemp-${taskId}`),
          String(args.goal_id ?? "GOAL-002"),
          String(args.conversation_ref ?? "chatgpt-mcp"),
          "lease-mcp-submit",
          String(args.workspace_id ?? "default"),
          kind,
          description.slice(0, 500),
          JSON.stringify(requestedActions),
          args.target_relpath ? String(args.target_relpath) : null,
          1,
          "READY",
          "submitted_via_gateway",
          null,
          null,
          0,
          now,
          now,
          null,
          null,
        );
        const task = monitor.inspectTask(taskId);
        return { ok: true, result: task };
      } finally {
        db.close();
      }
    }

    if (normalized === "monitor.respond") {
      const taskId = String(args.task_id ?? "");
      const summaryText = String(args.summary ?? "Confirmado por ISyMCP.");
      if (!taskId) throw new Error("monitor.respond requiere task_id");
      const { createHash } = await import("node:crypto");
      const { db, worker, monitor } = openBridgeMonitorStack();
      try {
        const task = monitor.inspectTask(taskId);
        if (!task) throw new Error(`Tarea no encontrada: ${taskId}`);
        const fullSummary = summaryText.includes("[ARGON-ACK]") ? summaryText : `[ARGON-ACK] ${summaryText}`;
        const artifactHash = `sha256:${createHash("sha256").update(`${taskId}:${fullSummary}`).digest("hex")}`;
        const now = Date.now();
        const resultObj = {
          exit_code: 0,
          output_summary: fullSummary,
          artifact_hash: artifactHash,
          completed_at: now,
        };
        db.query("UPDATE tasks SET state = 'SUCCEEDED', reason = 'argon_personal_response', result_json = ?, updated_at = ? WHERE task_id = ?").run(
          JSON.stringify(resultObj),
          now,
          taskId,
        );
        return {
          ok: true,
          result: {
            task_id: taskId,
            state: "SUCCEEDED",
            result: resultObj,
          },
        };
      } finally {
        db.close();
      }
    }

    // 6. Protocolo de Agentes
    if (
      normalized === "protocol" ||
      normalized === "protocol.read" ||
      normalized === "agents" ||
      normalized === "agent.md" ||
      normalized === "isymcp_agents.md"
    ) {
      return {
        ok: true,
        result: {
          protocol_document: "isymcp://protocol/agents.md",
          markdown: ISYMCP_AGENT_PROTOCOL_MD,
        },
      };
    }

    // 7. Familia Media
    if (normalized.startsWith("media.") || normalized.startsWith("media_")) {
      const mediaTool = normalized.replace(/^media\./, "media_");
      const { MediaService } = await import("../media/service");
      const service = new MediaService();
      const res = await service.call(mediaTool, args);
      const imageItem = res.content.find((c: any) => c.type === "image");
      if (imageItem) {
        return { ok: !res.isError, result: imageItem };
      }
      const text = res.content.find((c: any) => c.type === "text")?.text ?? "{}";
      try {
        const parsed = JSON.parse(text);
        return { ok: !res.isError, result: parsed, error: res.isError ? text : undefined };
      } catch {
        return { ok: !res.isError, result: text, error: res.isError ? text : undefined };
      }
    }

    // 8. Familia ComfyUI
    if (normalized.startsWith("comfyui.") || normalized.startsWith("comfy.") || normalized.startsWith("comfyui_")) {
      const comfyTool = normalized.replace(/^comfy(ui)?\./, "comfyui_");
      const { ComfyService } = await import("../comfyui/service");
      const service = new ComfyService();
      const res = await service.call(comfyTool, args);
      const imageItem = res.content.find((c: any) => c.type === "image");
      if (imageItem) {
        return { ok: !res.isError, result: imageItem };
      }
      const text = res.content.find((c: any) => c.type === "text")?.text ?? "{}";
      try {
        const parsed = JSON.parse(text);
        return { ok: !res.isError, result: parsed, error: res.isError ? text : undefined };
      } catch {
        return { ok: !res.isError, result: text, error: res.isError ? text : undefined };
      }
    }

    // 9. Familia Shell
    if (
      normalized === "shell.exec" ||
      normalized === "shell" ||
      normalized === "exec" ||
      normalized === "bash" ||
      normalized === "cmd"
    ) {
      const res = await executeShellCommand({
        command: String(args.command ?? args.cmd ?? ""),
        cwd: args.cwd ? String(args.cwd) : undefined,
        timeoutMs: args.timeout_ms ? Number(args.timeout_ms) : undefined,
      });
      return {
        ok: res.ok,
        result: res,
        error: res.ok ? undefined : res.stderr || `Comando falló con código ${res.exit_code}`,
      };
    }

    // 10. Familia Fuzz
    if (normalized === "fuzz.run" || normalized === "fuzz") {
      const { runFullFuzzSuite } = await import("../fuzzer");
      const iterations = typeof args.iterations === "number" && args.iterations > 0 ? args.iterations : 50;
      const report = await runFullFuzzSuite(iterations);
      return {
        ok: report.ok,
        result: report,
      };
    }

    return {
      ok: false,
      result: null,
      error: `Acción no soportada en el Gateway de ISyMCP: '${normalized}'. Consulta el glosario ejecutando isymcp(action='glossary').`,
    };
  } catch (err: any) {
    return {
      ok: false,
      result: null,
      error: (err as Error).message,
    };
  }
}

/**
 * Registra la herramienta universal `isymcp` en el servidor MCP.
 */
export function registerIsyMcpGateway(server: McpServer): void {
  server.registerTool(
    "isymcp",
    {
      description:
        "ISyMCP Universal Gateway — Interfaz unificada de ejecución estilo REA para todas las capacidades de ISyMCP en la máquina de Danny. " +
        "Contiene el glosario interactivo de herramientas (TUI Launcher con Antigravity, GitHub, Monitor de Tareas, Multimedia, ComfyUI). " +
        "Invoca con action='glossary' o sin argumentos para descubrir el catálogo de acciones disponibles con sus parámetros y ejemplos.",
      inputSchema: {
        action: z
          .string()
          .optional()
          .describe("Acción a ejecutar (ej. 'glossary', 'tui.spawn', 'github.status', 'github.api', 'github.repos', 'monitor.status', 'monitor.tasks', 'monitor.respond'). Si se omite, retorna el glosario completo."),
        arguments: z
          .record(z.string(), z.any())
          .optional()
          .describe("Parámetros o argumentos específicos para la acción seleccionada según el glosario."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const res = await dispatchIsyMcpAction(input.action, input.arguments as Record<string, any>);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(res.result !== undefined ? res.result : { error: res.error }, null, 2),
          },
        ],
        isError: !res.ok,
      };
    },
  );
}

/**
 * Registra las herramientas de solo lectura del Control Center para integración oficial con ChatGPT (CC-02).
 * Exclusivamente inspección: overview, glossary, tasks, protocol. Cero mutaciones ni shell.
 */
export function registerControlCenterMcpTools(server: McpServer): void {
  // 1. isymcp_get_overview
  server.registerTool(
    "isymcp_get_overview",
    {
      description:
        "Consulta la salud general del sistema ISyMCP, disponibilidad del bridge (:8791), monitor continuo (:8799), túnel seguro y métricas de memoria. Solo lectura.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const { getControlCenterOverview } = await import("../control-center/service");
      const overview = await getControlCenterOverview();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(overview, null, 2) }],
      };
    }
  );

  // 2. isymcp_get_glossary
  server.registerTool(
    "isymcp_get_glossary",
    {
      description:
        "Obtiene el glosario oficial de capacidades de ISyMCP con la descripción de contratos tipados, familias y parámetros. Solo lectura.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(ISYMCP_GLOSSARY, null, 2) }],
      };
    }
  );

  // 3. isymcp_get_tasks
  server.registerTool(
    "isymcp_get_tasks",
    {
      description:
        "Lista las tareas recientes persistidas en el buzón SQLite WAL del monitor continuo y sus recibos criptográficos HMAC. Solo lectura.",
      inputSchema: {
        limit: z.number().optional().default(10).describe("Límite máximo de tareas a retornar (por defecto 10)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const { getControlCenterTasks } = await import("../control-center/service");
      const tasks = getControlCenterTasks(input.limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }],
      };
    }
  );

  // 4. isymcp_get_protocol
  server.registerTool(
    "isymcp_get_protocol",
    {
      description:
        "Retorna el documento Markdown oficial de bootstrap y protocolo de coordinación de agentes interactivos (isymcp://protocol/agents.md). Solo lectura.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const { ISYMCP_AGENT_PROTOCOL_MD } = await import("../agent-protocol");
      return {
        content: [{ type: "text" as const, text: ISYMCP_AGENT_PROTOCOL_MD }],
      };
    }
  );
}
