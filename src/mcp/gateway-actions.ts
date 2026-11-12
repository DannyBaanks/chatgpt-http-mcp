// src/mcp/gateway-actions.ts — Registro ÚNICO de acciones del gateway `isymcp(action=...)`.
//
// Antes, el glosario (lo que ChatGPT lee con action='glossary') y los handlers (una cadena de
// `if (normalized === ...)`) eran dos fuentes separadas, y `describe` tenía su propio mapa de alias.
// Ahora cada acción declara aquí su nombre, alias, familia, entrada del glosario y handler; el
// glosario y `describe` se generan de esta lista (src/mcp/gateway.ts).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawnAgentTui } from "../tui-launcher";
import { checkGate } from "../permissions";
import { markTainted } from "../taint";
import { insertTask, respondTask } from "../monitor/tasks";
import { join as joinPath } from "node:path";
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

export interface GatewayResult {
  ok: boolean;
  result: unknown;
  error?: string;
}

export interface GatewayAction {
  /** Nombre canónico `<familia>.<acción>`. */
  name: string;
  family: string;
  /** Otros nombres que despacha (y que `describe` también entiende). */
  aliases?: string[];
  /** Nombres que solo `describe` entiende (atajos de documentación). */
  describeAliases?: string[];
  glossary: GlossaryEntry;
  /** Sin handler: se resuelve por una familia de prefijo (media.*, comfyui.*). */
  handler?: (args: Record<string, any>, normalized: string) => Promise<GatewayResult>;
}

export interface PrefixFamily {
  family: string;
  matches: (normalized: string) => boolean;
  handler: (args: Record<string, any>, normalized: string) => Promise<GatewayResult>;
}

/** Cabecera del glosario. */
export const GLOSSARY_HEADER = {
  "isymcp_version": "1.1.0",
  "gateway": "isymcp",
  "description": "Glosario oficial de capacidades de ISyMCP (Universal Gateway estilo REA).",
  "usage_instruction": "Para invocar cualquier herramienta usa: isymcp(action='<familia>.<accion>', arguments={...}). Para ver este glosario usa: isymcp(action='glossary')."
};

/** Descripción de cada familia, en el orden en que aparece en el glosario. */
export const FAMILY_DESCRIPTIONS: Record<string, string> = {
  "tui": "Orquestación y despliegue de consolas interactivas de agentes (agy, claude, opencode, openisy, codex, gemini, copilot, droid, kimi, crush, hermes, openclaw) en el escritorio local.",
  "github": "Operaciones autenticadas con GitHub mediante el token PAT de Danny (DannyBaanks) almacenado en ISyMCP.",
  "monitor": "Coordinación asíncrona, colas de tareas con SQLite WAL y recibos criptográficos HMAC.",
  "media": "Análisis técnico y preparación de archivos de audio y video locales sin salir de la máquina.",
  "comfyui": "Generación de imágenes y workflows locales con ComfyUI.",
  "protocol": "Protocolo oficial de bootstrap, persistencia y ciclo de vida para agentes interactivos.",
  "shell": "Ejecución directa de comandos shell/bash en la máquina de Danny con persistencia de directorio de trabajo (cwd).",
  "fuzz": "Suite de pruebas adversariales y fuzzing para configs de TUIs y Universal Gateway."
};

/** Entrada del CLI isymcp que las consolas usan para responder. */
function isymcpCliEntry(): string {
  return joinPath(import.meta.dir, "..", "isymcp.ts");
}

export const GATEWAY_ACTIONS: GatewayAction[] = [
  {
    name: "tui.spawn",
    family: "tui",
    aliases: ["spawn", "tui"],
    glossary: {
      "description": "Abre una consola TUI de un agente (por defecto agy) en una ventana visible (gnome-terminal/tmux) con auto-registro de tarea, identidad de consola y enlace al bus del monitor. Usa tui.agents para ver qué agentes hay instalados.",
      "parameters": {
        "prompt": "string (obligatorio: instrucción o tarea para el nuevo agente)",
        "agent": "string (opcional, por defecto 'agy'): agy | claude | opencode | openisy | codex | gemini | copilot | droid | kimi | crush | hermes | openclaw",
        "mode": "enum: 'plan' | 'auto' | 'accept-edits' (por defecto 'auto')",
        "title": "string (opcional: título de la ventana)",
        "terminal": "enum: 'auto' | 'gui' | 'tmux' (por defecto 'auto')",
        "task_id": "string (opcional: ID de tarea para vincular con el monitor, auto-generado si se omite)",
        "operation_id": "string (opcional: ID de operación asociada)"
      },
      "example": {
        "action": "tui.spawn",
        "arguments": {
          "prompt": "Auditar arquitectura y pruebas en modo seguro",
          "agent": "opencode"
        }
      }
    },
    handler: async (args) => {
    const dryRunOnly = args.dryRun === true || args.dry_run === true; // no ejecuta nada: solo muestra el comando
    if (!dryRunOnly) {
      const gate = checkGate("agent_spawn", "tui.spawn", { agent: String(args.agent ?? "agy"), cwd: args.cwd, prompt: String(args.prompt ?? "") });
      if (!gate.ok) return { ok: false, result: null, error: gate.message };
    }
    // Saltarse los permisos del agente solo desde la CLI local del operador, nunca por el gateway.
    if (args.dangerously_skip_permissions === true) {
      return { ok: false, result: null, error: "DENIED: dangerously_skip_permissions solo desde la CLI local (isymcp tui spawn), no por MCP" };
    }
    const res = await spawnAgentTui({
      agent: args.agent ? String(args.agent) : "agy",
      prompt: String(args.prompt ?? "Hola Danny, consola coordinada por ISyMCP"),
      cwd: args.cwd ? String(args.cwd) : undefined,
      title: args.title ? String(args.title) : undefined,
      mode: args.mode as any,
      terminalPreference: args.terminal as any,
      dangerouslySkipPermissions: false,
      includeMonitorHint: args.include_monitor_hint !== false,
      dryRun: args.dryRun === true || args.dry_run === true,
      taskId: args.task_id ? String(args.task_id) : undefined,
      operationId: args.operation_id ? String(args.operation_id) : undefined,
    });
    return { ok: res.ok, result: res, error: res.error };
    },
  },
  {
    name: "tui.agents",
    family: "tui",
    aliases: ["agents.list"],
    glossary: {
      "description": "Catálogo multiharness: por agente, si está instalado, cómo recibe el prompt inicial (argv o pegado) y cómo le llegan las tareas siguientes (agy-task, background-bash o inject por tmux).",
      "parameters": {},
      "example": {
        "action": "tui.agents"
      }
    },
    handler: async (args) => {
    const { AGENT_TUIS, findAgentBinary } = await import("../agent-tuis");
    return {
      ok: true,
      result: AGENT_TUIS.map((a) => ({
        agent: a.id, label: a.label, aliases: a.aliases, installed: Boolean(findAgentBinary(a)),
        prompt_via: a.promptVia, listener: a.listener, skip_permissions: a.id === "agy",
      })),
    };
    },
  },
  {
    name: "tui.consoles",
    family: "tui",
    aliases: ["monitor.consoles", "consoles", "console"],
    glossary: {
      "description": "Lista las consolas TUI lanzadas con su identidad determinista: console_id, PID real de agy, alive (kill -0 en vivo), estado (SPAWNED/ACKED/RUNNING/COMPLETED/FAILED), token_fp, task_id y ACK firmado. Úsala para saber qué consola es cuál.",
      "parameters": {
        "limit": "number (opcional, por defecto 20)"
      },
      "example": {
        "action": "tui.consoles"
      }
    },
    handler: async (args) => {
    const { listConsoles } = await import("../console-registry");
    const { db, env } = openBridgeMonitorStack();
    try {
      return { ok: true, result: listConsoles(db, Number(args.limit ?? 20), env) };
    } catch (e) {
      return { ok: false, result: null, error: (e as Error).message };
    } finally {
      db.close();
    }
    },
  },
  {
    name: "tui.log",
    family: "tui",
    aliases: ["monitor.console_log", "console-log", "console_log"],
    glossary: {
      "description": "Log cronológico (JSONL) de una consola: spawn, PID registrado, ACK firmado, avances y cierre.",
      "parameters": {
        "console_id": "string (con-xxxxxxxx) o task_id",
        "tail": "number (opcional, últimos N eventos, por defecto 50)"
      },
      "example": {
        "action": "tui.log",
        "arguments": {
          "console_id": "con-8f3a19c2",
          "tail": 20
        }
      }
    },
    handler: async (args) => {
    const { readConsoleLog } = await import("../console-registry");
    const { db } = openBridgeMonitorStack();
    try {
      const target = String(args.console_id ?? args.task_id ?? "");
      if (!target) return { ok: false, result: null, error: "tui.log requiere console_id (o task_id)" };
      return { ok: true, result: readConsoleLog(db, target, Number(args.tail ?? 50)) };
    } catch (e) {
      return { ok: false, result: null, error: (e as Error).message };
    } finally {
      db.close();
    }
    },
  },
  {
    name: "github.status",
    family: "github",
    glossary: {
      "description": "Consulta el estado del token activo, scopes, cuota de rate-limit y usuario autenticado.",
      "parameters": {},
      "example": {
        "action": "github.status"
      }
    },
    handler: async (args) => {
    const res = await GITHUB_MCP_TOOLS.github_status.handler();
    return { ok: true, result: res };
    },
  },
  {
    name: "github.whoami",
    family: "github",
    glossary: {
      "description": "Perfil detallado de la cuenta autenticada y organizaciones asociadas.",
      "parameters": {},
      "example": {
        "action": "github.whoami"
      }
    },
    handler: async (args) => {
    const res = await callGitHubApi("/user");
    return { ok: res.ok, result: res.data, error: res.error };
    },
  },
  {
    name: "github.repos",
    family: "github",
    glossary: {
      "description": "Lista repositorios del usuario u organización.",
      "parameters": {
        "user": "string (opcional: si se omite lista los del usuario autenticado)"
      },
      "example": {
        "action": "github.repos",
        "arguments": {
          "user": "DannyBaanks"
        }
      }
    },
    handler: async (args) => {
    const user = args.user ? String(args.user) : undefined;
    const endpoint = user ? `/users/${user}/repos` : "/user/repos";
    const res = await callGitHubApi(endpoint);
    if (res.ok) markTainted("github.repos", endpoint);
    return { ok: res.ok, result: res.data, error: res.error };
    },
  },
  {
    name: "github.prs",
    family: "github",
    glossary: {
      "description": "Lista pull requests de un repositorio.",
      "parameters": {
        "owner": "string (dueño del repositorio)",
        "repo": "string (nombre del repositorio)",
        "state": "enum: 'open' | 'closed' | 'all' (por defecto 'open')"
      },
      "example": {
        "action": "github.prs",
        "arguments": {
          "owner": "DannyBaanks",
          "repo": "chatgpt-http-mcp",
          "state": "open"
        }
      }
    },
    handler: async (args) => {
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    if (!owner || !repo) throw new Error("github.prs requiere owner y repo");
    const state = String(args.state ?? "open");
    const res = await callGitHubApi(`/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}`);
    if (res.ok) markTainted("github.prs", `${owner}/${repo}`);
    return { ok: res.ok, result: res.data, error: res.error };
    },
  },
  {
    name: "github.issues",
    family: "github",
    glossary: {
      "description": "Lista issues de un repositorio.",
      "parameters": {
        "owner": "string (dueño)",
        "repo": "string (nombre del repo)",
        "state": "enum: 'open' | 'closed' | 'all' (por defecto 'open')"
      },
      "example": {
        "action": "github.issues",
        "arguments": {
          "owner": "DannyBaanks",
          "repo": "chatgpt-http-mcp"
        }
      }
    },
    handler: async (args) => {
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    if (!owner || !repo) throw new Error("github.issues requiere owner y repo");
    const state = String(args.state ?? "open");
    const res = await callGitHubApi(`/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}`);
    if (res.ok) markTainted("github.issues", `${owner}/${repo}`);
    return { ok: res.ok, result: res.data, error: res.error };
    },
  },
  {
    name: "github.api",
    family: "github",
    glossary: {
      "description": "Ejecuta cualquier llamada REST v3 o GraphQL oficial de GitHub con el token activo.",
      "parameters": {
        "endpoint": "string (ej. '/user', '/repos/DannyBaanks/WINS')",
        "method": "enum: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' (por defecto 'GET')",
        "params": "record (parámetros querystring opcionales)",
        "body": "record (cuerpo JSON para POST/PATCH)"
      },
      "example": {
        "action": "github.api",
        "arguments": {
          "endpoint": "/repos/DannyBaanks/WINS"
        }
      }
    },
    handler: async (args) => {
    const res = await GITHUB_MCP_TOOLS.github_api.handler({
      endpoint: String(args.endpoint ?? "/user"),
      method: args.method as any,
      params: args.params,
      body: args.body,
    });
    return { ok: res.ok, result: res.data ?? res, error: res.error };
    },
  },
  {
    name: "github.dispatch",
    family: "github",
    glossary: {
      "description": "Dispara un flujo de trabajo (workflow_dispatch) de GitHub Actions.",
      "parameters": {
        "owner": "string (dueño)",
        "repo": "string (repositorio)",
        "workflow_id": "string (ej. ci.yml)",
        "ref": "string (rama o tag, por defecto 'main')",
        "inputs": "record (parámetros de entrada del workflow)"
      },
      "example": {
        "action": "github.dispatch",
        "arguments": {
          "owner": "DannyBaanks",
          "repo": "chatgpt-http-mcp",
          "workflow_id": "ci.yml",
          "ref": "main"
        }
      }
    },
    handler: async (args) => {
    const res = await GITHUB_MCP_TOOLS.github_dispatch_workflow.handler({
      owner: String(args.owner ?? ""),
      repo: String(args.repo ?? ""),
      workflow_id: String(args.workflow_id ?? "ci.yml"),
      ref: args.ref ? String(args.ref) : "main",
      inputs: args.inputs,
    });
    return { ok: res.ok, result: res, error: res.error };
    },
  },
  {
    name: "github.exec",
    family: "github",
    glossary: {
      "description": "Ejecuta comandos CLI nativos de GitHub (gh).",
      "parameters": {
        "args": "array de strings con los argumentos para gh (ej. ['pr', 'list'])"
      },
      "example": {
        "action": "github.exec",
        "arguments": {
          "args": [
            "pr",
            "list",
            "--state",
            "open"
          ]
        }
      }
    },
    handler: async (args) => {
    const res = await GITHUB_MCP_TOOLS.github_exec.handler({
      args: Array.isArray(args.args) ? args.args.map(String) : [],
    });
    return { ok: res.ok, result: res };
    },
  },
  {
    name: "monitor.status",
    family: "monitor",
    describeAliases: ["status"],
    glossary: {
      "description": "Consulta el estado del demonio del monitor, leases activos y tareas recientes.",
      "parameters": {},
      "example": {
        "action": "monitor.status"
      }
    },
    handler: async (args) => {
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
    },
  },
  {
    name: "monitor.tasks",
    family: "monitor",
    describeAliases: ["tasks"],
    glossary: {
      "description": "Lista las tareas registradas en la cola del monitor con sus estados y recibos.",
      "parameters": {
        "limit": "number (opcional, por defecto 20)"
      },
      "example": {
        "action": "monitor.tasks",
        "arguments": {
          "limit": 10
        }
      }
    },
    handler: async (args) => {
    const { db, monitor } = openBridgeMonitorStack();
    try {
      const limit = Number(args.limit ?? 20);
      const tasks = monitor.listTasks(limit);
      return { ok: true, result: tasks };
    } finally {
      db.close();
    }
    },
  },
  {
    name: "monitor.submit",
    family: "monitor",
    describeAliases: ["submit"],
    glossary: {
      "description": "Encola una tarea estructurada para ejecución o supervisión.",
      "parameters": {
        "operation_id": "string",
        "console_id": "string (opcional: dirige la tarea SOLO a esa consola; agy/claude la reciben con wait-next --console, las demás TUIs la reciben pegada en su terminal)",
        "kind": "string (ej. 'diagnostics', 'review_and_test')",
        "description": "string",
        "requested_actions": "array de strings (ej. ['status:read', 'tests:run', 'report:write'])"
      },
      "example": {
        "action": "monitor.submit",
        "arguments": {
          "operation_id": "op-check-001",
          "kind": "diagnostics",
          "description": "Verificar integridad del monitor",
          "requested_actions": [
            "status:read"
          ]
        }
      }
    },
    handler: async (args) => {
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
      insertTask(db, {
        task_id: taskId,
        operation_id: operationId,
        idempotency_key: String(args.idempotency_key ?? `idemp-${taskId}`),
        goal_id: String(args.goal_id ?? "GOAL-002"),
        conversation_ref: args.console_id ? `console:${String(args.console_id)}` : String(args.conversation_ref ?? "chatgpt-mcp"),
        lease_id: "lease-mcp-submit",
        workspace_id: String(args.workspace_id ?? "default"),
        kind,
        description: description.slice(0, 500),
        requested_actions: requestedActions,
        target_relpath: args.target_relpath ? String(args.target_relpath) : null,
        state: "READY",
        reason: "submitted_via_gateway",
        created_at: now,
      });
      const task = monitor.inspectTask(taskId);
      // Consolas sin listener propio (opencode, openisy, codex...): la tarea se pega en su terminal.
      let delivery: { delivered: boolean; reason: string } | undefined;
      if (args.console_id) {
        try {
          const { getConsole } = await import("../console-registry");
          const { deliverTaskToConsole } = await import("../console-delivery");
          const rec = getConsole(db, String(args.console_id));
          const gate = rec ? checkGate("agent_spawn", "monitor.submit.delivery", { console_id: String(args.console_id), agent: rec.agent, task_id: taskId }) : null;
          delivery = gate && !gate.ok
            ? { delivered: false, reason: "agent_spawn_disabled" }
            : rec
              ? deliverTaskToConsole(rec, { task_id: taskId, kind, description }, isymcpCliEntry())
              : { delivered: false, reason: "console_not_found" };
        } catch (e) {
          delivery = { delivered: false, reason: `delivery_error: ${(e as Error).message}` };
        }
      }
      return { ok: true, result: delivery ? { ...task, delivery } : task };
    } finally {
      db.close();
    }
    },
  },
  {
    name: "monitor.respond",
    family: "monitor",
    describeAliases: ["respond"],
    glossary: {
      "description": "Envía un reporte de avance o ACK a una tarea con recibo firmado.",
      "parameters": {
        "task_id": "string (ID de la tarea a responder)",
        "summary": "string (texto del reporte o veredicto)"
      },
      "example": {
        "action": "monitor.respond",
        "arguments": {
          "task_id": "task-tui-12345",
          "summary": "Tarea completada exitosamente."
        }
      }
    },
    handler: async (args) => {
    const taskId = String(args.task_id ?? "");
    const summaryText = String(args.summary ?? "Confirmado por ISyMCP.");
    if (!taskId) throw new Error("monitor.respond requiere task_id");
    const { db, worker, monitor } = openBridgeMonitorStack();
    try {
      const task = monitor.inspectTask(taskId);
      if (!task) throw new Error(`Tarea no encontrada: ${taskId}`);
      const resultObj = respondTask(db, taskId, summaryText);
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
    },
  },
  {
    name: "media.list",
    family: "media",
    glossary: {
      "description": "Lista los activos multimedia registrados en el inventario local.",
      "parameters": {}
    },
  },
  {
    name: "media.info",
    family: "media",
    glossary: {
      "description": "Obtiene metadatos técnicos, codecs y streams de un activo registrado.",
      "parameters": {
        "asset_id": "string"
      }
    },
  },
  {
    name: "media.lookup",
    family: "media",
    glossary: {
      "description": "Comprueba si una URL de YouTube o video ya está preparada localmente.",
      "parameters": {
        "url": "string"
      }
    },
  },
  {
    name: "comfyui.status",
    family: "comfyui",
    glossary: {
      "description": "Estado de salud del servicio ComfyUI en loopback.",
      "parameters": {}
    },
  },
  {
    name: "comfyui.workflows",
    family: "comfyui",
    glossary: {
      "description": "Catálogo de workflows disponibles en el entorno local.",
      "parameters": {}
    },
  },
  {
    name: "comfyui.generate",
    family: "comfyui",
    glossary: {
      "description": "Encola la generación de una imagen en un workflow específico.",
      "parameters": {
        "workflow_id": "string",
        "inputs": "record"
      }
    },
  },
  {
    name: "protocol.read",
    family: "protocol",
    aliases: ["protocol", "agents", "agent.md", "isymcp_agents.md"],
    glossary: {
      "description": "Retorna el documento Markdown con las instrucciones de inicialización y comandos de persistencia (/task) para agentes coordinados por ChatGPT.",
      "parameters": {},
      "example": {
        "action": "protocol.read"
      }
    },
    handler: async (args) => {
    return {
      ok: true,
      result: {
        protocol_document: "isymcp://protocol/agents.md",
        markdown: ISYMCP_AGENT_PROTOCOL_MD,
      },
    };
    },
  },
  {
    name: "shell.exec",
    family: "shell",
    aliases: ["shell", "exec", "bash", "cmd"],
    glossary: {
      "description": "Ejecuta un comando arbitrario en bash con soporte para cwd persistente, navegación con 'cd <ruta>', variables de entorno y piping.",
      "parameters": {
        "command": "string (obligatorio: comando bash a ejecutar)",
        "cwd": "string (opcional: directorio de trabajo inicial)",
        "timeout_ms": "number (opcional: tiempo límite en ms, por defecto 30000)"
      },
      "example": {
        "action": "shell.exec",
        "arguments": {
          "command": "git status"
        }
      }
    },
    handler: async (args) => {
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
    },
  },
  {
    name: "fuzz.run",
    family: "fuzz",
    aliases: ["fuzz"],
    glossary: {
      "description": "Ejecuta pruebas sintácticas y semánticas intensivas contra el instalador TUI y el despachador de herramientas.",
      "parameters": {
        "iterations": "number (opcional: iteraciones por suite, por defecto 50)"
      },
      "example": {
        "action": "fuzz.run",
        "arguments": {
          "iterations": 25
        }
      }
    },
    handler: async (args) => {
    const { runFullFuzzSuite } = await import("../fuzzer");
    const iterations = typeof args.iterations === "number" && args.iterations > 0 ? args.iterations : 50;
    const report = await runFullFuzzSuite(iterations);
    return {
      ok: report.ok,
      result: report,
    };
    },
  },
];

export const PREFIX_FAMILIES: PrefixFamily[] = [
  {
    family: "media",
    matches: (normalized) => normalized.startsWith("media.") || normalized.startsWith("media_"),
    handler: async (args, normalized) => {
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
    },
  },
  {
    family: "comfyui",
    matches: (normalized) => normalized.startsWith("comfyui.") || normalized.startsWith("comfy.") || normalized.startsWith("comfyui_"),
    handler: async (args, normalized) => {
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
    },
  },
];
