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
import { diagnose, errorCatalog, recentErrors } from "../bridge-errors";

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
  "errors": "Diagnóstico de fallos del bridge: catálogo de códigos (causa, remedio, quién lo arregla), explicación de un mensaje de error y últimos fallos reales de la máquina (tools, permisos denegados, salud del túnel).",
  "tui": "Orquestación y despliegue de consolas interactivas de agentes (agy, claude, opencode, openisy, isycode, codex, gemini, copilot, droid, kimi, crush, hermes, openclaw) en el escritorio local.",
  "github": "Operaciones autenticadas con GitHub mediante el token PAT de Danny (DannyBaanks) almacenado en ISyMCP.",
  "monitor": "Coordinación asíncrona, colas de tareas con SQLite WAL y recibos criptográficos HMAC.",
  "media": "Análisis técnico y preparación de archivos de audio y video locales sin salir de la máquina.",
  "comfyui": "Generación de imágenes y workflows locales con ComfyUI.",
  "protocol": "Protocolo oficial de bootstrap, persistencia y ciclo de vida para agentes interactivos.",
  "shell": "Ejecución directa de comandos shell/bash en la máquina de Danny con persistencia de directorio de trabajo (cwd).",
  "fuzz": "Suite de pruebas adversariales y fuzzing para configs de TUIs y Universal Gateway.",
  "openisy": "Túnel bidireccional hacia OpenISy/OpenCode (HTTP v2 Daemon) para orquestar su TUI en vivo (como usuario o como agente sintético) y despachar sub-agentes multi-provider con o sin API keys externas.",
  "openswift": "Simulador visual de pantallas SwiftUI en iPhone e iPad (OpenSwift): renderiza código o archivos .swift a capturas PNG Retina para que el modelo vea visualmente la interfaz.",
  "handoff": "Carga unificada en 1 paso de handoffs compactados por NVIDIA Nemotron en el Baúl (`compacted/`) junto con verificación viva de archivos, estado git y búsqueda `ziggrep`."
};

/** Entrada del CLI isymcp que las consolas usan para responder. */
function isymcpCliEntry(): string {
  return joinPath(import.meta.dir, "..", "isymcp.ts");
}

export const GATEWAY_ACTIONS: GatewayAction[] = [
  {
    name: "errors.catalog",
    family: "errors",
    aliases: ["errors", "error_catalog"],
    glossary: {
      "description": "Catálogo completo de códigos de fallo de ISyMCP: capa (transport/token/permission/sandbox/arguments/process/internal), quién lo arregla (model = tú reintentas distinto; operator = Danny en su terminal), causa, remedio y comando sugerido para Danny.",
      "parameters": {},
      "example": {},
    },
    handler: async () => ({ ok: true, result: { codes: errorCatalog() } }),
  },
  {
    name: "errors.explain",
    family: "errors",
    aliases: ["error_explain", "explain_error"],
    glossary: {
      "description": "Explica un mensaje de error (aunque venga de tu lado, p. ej. 'McpServerError: Session terminated') o un código del catálogo: devuelve {code, layer, who_fixes, cause, remedy, command}.",
      "parameters": { "message": "Texto exacto del error o código (string, requerido)" },
      "example": { "message": "INVALID_ARGUMENT: McpServerError: Session terminated" },
    },
    handler: async (args) => {
      const message = String(args.message ?? args.error ?? args.code ?? "").trim();
      if (!message) return { ok: false, result: null, error: "message requerido" };
      return { ok: true, result: diagnose(message) };
    },
  },
  {
    name: "errors.recent",
    family: "errors",
    aliases: ["error_recent", "last_errors"],
    glossary: {
      "description": "Últimos fallos reales en la máquina de Danny, cada uno con su diagnosis: errores de tools codex_*, permisos denegados (shell/agents) y salud de los túneles (poll timeouts seguidos = túnel atascado). Úsalo para decirle a Danny qué falló y cómo arreglarlo.",
      "parameters": { "limit": "Máximo de entradas por lista (int, 1-100, por defecto 20)" },
      "example": { "limit": 10 },
    },
    handler: async (args) => ({ ok: true, result: recentErrors(Number(args.limit ?? 20)) }),
  },
  {
    name: "tui.spawn",
    family: "tui",
    aliases: ["spawn", "tui"],
    glossary: {
      "description": "Abre una consola TUI de un agente (por defecto agy) en una ventana visible (gnome-terminal/tmux) con auto-registro de tarea, identidad de consola y enlace al bus del monitor. Usa tui.agents para ver qué agentes hay instalados.",
      "parameters": {
        "prompt": "string (obligatorio: instrucción o tarea para el nuevo agente)",
        "agent": "string (opcional, por defecto 'agy'): agy | claude | opencode | openisy | isycode | codex | gemini | copilot | droid | kimi | crush | hermes | openclaw",
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
    name: "tui.send",
    family: "tui",
    aliases: ["console.send", "tui.paste"],
    glossary: {
      "description": "Escribe un mensaje o comando slash (ej. '/compact') directamente en la terminal tmux de una consola TUI como si el usuario tecleara en vivo (bracketed paste + Enter opcional), sin envoltorio de tarea.",
      "parameters": {
        "console_id": "string (con-xxxxxxxx o task_id de la consola; alternativo a tmux_session)",
        "tmux_session": "string (opcional: nombre directo de la sesión tmux si no se usa console_id)",
        "tmux_socket": "string (opcional: socket tmux -L, por defecto 'isymcp-consoles')",
        "text": "string (obligatorio: mensaje o comando a enviar)",
        "submit": "boolean (opcional, por defecto true: envía Enter después de pegar)"
      },
      "example": {
        "action": "tui.send",
        "arguments": {
          "console_id": "con-8f3a19c2",
          "text": "Revisa también los tests de regresión antes de cerrar",
          "submit": true
        }
      }
    },
    handler: async (args) => {
      const text = String(args.text ?? args.prompt ?? args.message ?? "");
      if (!text) return { ok: false, result: null, error: "tui.send requiere 'text'" };
      const gate = checkGate("agent_spawn", "tui.send", {
        console_id: args.console_id ? String(args.console_id) : undefined,
        tmux_session: args.tmux_session ? String(args.tmux_session) : undefined,
        text,
      });
      if (!gate.ok) return { ok: false, result: null, error: gate.message };

      const { consoleTmuxSocket, sendRawToTmux } = await import("../console-delivery");
      let socket = args.tmux_socket ? String(args.tmux_socket) : consoleTmuxSocket();
      let session = args.tmux_session ? String(args.tmux_session) : "";
      if (!session && (args.console_id || args.task_id)) {
        const { getConsole } = await import("../console-registry");
        const { db } = openBridgeMonitorStack();
        try {
          const rec = getConsole(db, String(args.console_id ?? args.task_id));
          if (!rec) return { ok: false, result: null, error: `console_not_found:${String(args.console_id ?? args.task_id)}` };
          if (!rec.tmux_session) return { ok: false, result: null, error: `La consola ${rec.console_id} (${rec.agent}) no tiene sesión tmux asociada` };
          session = rec.tmux_session;
          if (rec.tmux_socket) socket = rec.tmux_socket;
        } finally {
          db.close();
        }
      }
      if (!session) return { ok: false, result: null, error: "tui.send requiere 'console_id' o 'tmux_session'" };
      const submit = args.submit !== false;
      const delivery = sendRawToTmux(socket, session, text, submit);
      return {
        ok: delivery.delivered,
        result: { tmux_socket: socket, tmux_session: session, submit, ...delivery },
        error: delivery.delivered ? undefined : delivery.reason,
      };
    },
  },
  {
    name: "tui.keys",
    family: "tui",
    aliases: ["console.keys"],
    glossary: {
      "description": "Envía teclas especiales ('Escape', 'C-c', 'Enter', 'Tab', 'y', 'Up', 'Down') a la sesión tmux de una consola TUI para cancelar turnos, navegar menús o confirmar diálogos interactivos.",
      "parameters": {
        "console_id": "string (con-xxxxxxxx o task_id; alternativo a tmux_session)",
        "tmux_session": "string (opcional: sesión tmux directa)",
        "tmux_socket": "string (opcional: socket tmux -L, por defecto 'isymcp-consoles')",
        "keys": "array de strings o string separado por espacios (ej. ['Escape'] o ['y', 'Enter'])"
      },
      "example": {
        "action": "tui.keys",
        "arguments": {
          "console_id": "con-8f3a19c2",
          "keys": ["y", "Enter"]
        }
      }
    },
    handler: async (args) => {
      const rawKeys = Array.isArray(args.keys)
        ? args.keys.map(String)
        : typeof args.keys === "string"
          ? args.keys.trim().split(/\s+/).filter(Boolean)
          : [];
      if (rawKeys.length === 0) return { ok: false, result: null, error: "tui.keys requiere 'keys' (ej. ['Escape'] o ['Enter'])" };
      const gate = checkGate("agent_spawn", "tui.keys", {
        console_id: args.console_id ? String(args.console_id) : undefined,
        tmux_session: args.tmux_session ? String(args.tmux_session) : undefined,
        keys: rawKeys.join(","),
      });
      if (!gate.ok) return { ok: false, result: null, error: gate.message };

      const { consoleTmuxSocket, sendKeysToTmux } = await import("../console-delivery");
      let socket = args.tmux_socket ? String(args.tmux_socket) : consoleTmuxSocket();
      let session = args.tmux_session ? String(args.tmux_session) : "";
      if (!session && (args.console_id || args.task_id)) {
        const { getConsole } = await import("../console-registry");
        const { db } = openBridgeMonitorStack();
        try {
          const rec = getConsole(db, String(args.console_id ?? args.task_id));
          if (!rec) return { ok: false, result: null, error: `console_not_found:${String(args.console_id ?? args.task_id)}` };
          if (!rec.tmux_session) return { ok: false, result: null, error: `La consola ${rec.console_id} (${rec.agent}) no tiene sesión tmux asociada` };
          session = rec.tmux_session;
          if (rec.tmux_socket) socket = rec.tmux_socket;
        } finally {
          db.close();
        }
      }
      if (!session) return { ok: false, result: null, error: "tui.keys requiere 'console_id' o 'tmux_session'" };
      const delivery = sendKeysToTmux(socket, session, rawKeys);
      return {
        ok: delivery.delivered,
        result: { tmux_socket: socket, tmux_session: session, keys: rawKeys, ...delivery },
        error: delivery.delivered ? undefined : delivery.reason,
      };
    },
  },
  {
    name: "tui.capture",
    family: "tui",
    aliases: ["tui.screen", "tui.read", "console.capture"],
    glossary: {
      "description": "Captura el texto visible en la pantalla terminal (tmux capture-pane) de una consola TUI para ver qué está haciendo o preguntando en tiempo real.",
      "parameters": {
        "console_id": "string (con-xxxxxxxx o task_id; alternativo a tmux_session)",
        "tmux_session": "string (opcional: sesión tmux directa)",
        "tmux_socket": "string (opcional: socket tmux -L, por defecto 'isymcp-consoles')",
        "lines": "number (opcional: últimas N líneas a capturar, por defecto 80)"
      },
      "example": {
        "action": "tui.capture",
        "arguments": {
          "console_id": "con-8f3a19c2",
          "lines": 80
        }
      }
    },
    handler: async (args) => {
      const { captureTmuxPane, consoleTmuxSocket } = await import("../console-delivery");
      let socket = args.tmux_socket ? String(args.tmux_socket) : consoleTmuxSocket();
      let session = args.tmux_session ? String(args.tmux_session) : "";
      if (!session && (args.console_id || args.task_id)) {
        const { getConsole } = await import("../console-registry");
        const { db } = openBridgeMonitorStack();
        try {
          const rec = getConsole(db, String(args.console_id ?? args.task_id));
          if (!rec) return { ok: false, result: null, error: `console_not_found:${String(args.console_id ?? args.task_id)}` };
          if (!rec.tmux_session) return { ok: false, result: null, error: `La consola ${rec.console_id} (${rec.agent}) no tiene sesión tmux asociada` };
          session = rec.tmux_session;
          if (rec.tmux_socket) socket = rec.tmux_socket;
        } finally {
          db.close();
        }
      }
      if (!session) return { ok: false, result: null, error: "tui.capture requiere 'console_id' o 'tmux_session'" };
      const res = captureTmuxPane(socket, session, Number(args.lines ?? 80));
      return {
        ok: res.ok,
        result: { tmux_socket: socket, tmux_session: session, screen: res.screen },
        error: res.ok ? undefined : res.reason,
      };
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
  {
    name: "openisy.sessions",
    family: "openisy",
    aliases: ["openisy.status", "openisy.list", "openisy"],
    glossary: {
      "description": "Inspecciona el daemon HTTP v2 activo de OpenISy (u OpenCode): sesiones corriendo en vivo en la TUI, historial de sesiones, catálogo de agentes ('build', 'plan', 'general', 'explore', 'Step-5-preview') y providers configurados ('freellmapi', 'xkiro', 'nvidia', 'isyco-web').",
      "parameters": {
        "target": "enum opcional: 'openisy' (por defecto) | 'opencode'",
        "limit": "number (opcional: máximo de sesiones a listar, por defecto 10)",
        "directory": "string (opcional: filtrar sesiones por ruta de proyecto)",
        "parent_id": "string (opcional: filtrar sub-agentes hijos de una sesión o 'null' para raíz)"
      },
      "example": {
        "action": "openisy.sessions",
        "arguments": {
          "limit": 5
        }
      }
    },
    handler: async (args) => {
      const { listOpenIsyOverview } = await import("../openisy-tunnel");
      const res = await listOpenIsyOverview(args);
      return { ok: true, result: res };
    },
  },
  {
    name: "openisy.messages",
    family: "openisy",
    aliases: ["openisy.read", "openisy.history"],
    glossary: {
      "description": "Lee los mensajes recientes, razonamiento, llamadas a herramientas, permisos pendientes y formularios de una sesión de OpenISy (si se omite session_id, usa automáticamente la sesión activa en la TUI).",
      "parameters": {
        "session_id": "string (opcional: ID 'ses_...' o 'active'/'latest' por defecto)",
        "limit": "number (opcional: cantidad de mensajes recientes, por defecto 10)",
        "type": "enum opcional: 'user' | 'assistant' | 'synthetic' | 'system' | 'shell'",
        "target": "enum opcional: 'openisy' (por defecto) | 'opencode'"
      },
      "example": {
        "action": "openisy.messages",
        "arguments": {
          "session_id": "active",
          "limit": 6
        }
      }
    },
    handler: async (args) => {
      const { readOpenIsySession } = await import("../openisy-tunnel");
      const res = await readOpenIsySession(args);
      return { ok: true, result: res };
    },
  },
  {
    name: "openisy.send",
    family: "openisy",
    aliases: ["openisy.prompt", "openisy.inject"],
    glossary: {
      "description": "Envía un mensaje a una sesión TUI de OpenISy como si fueras Danny (as='user', soportando delivery='steer' para redirigir en vivo o 'queue' para encolar, y menciones a sub-agentes), como si fueras el propio agente/arnés de la TUI (as='synthetic'), o ejecuta un comando interno (as='command').",
      "parameters": {
        "session_id": "string (opcional: 'ses_...' o 'active'/'latest' por defecto para apuntar a la TUI abierta)",
        "text": "string (obligatorio: contenido del mensaje o instrucción)",
        "as": "enum opcional: 'user' (por defecto) | 'synthetic' | 'command'",
        "delivery": "enum opcional: 'steer' (interrumpe/redirige en caliente) | 'queue' (encola en el buzón)",
        "agents": "array opcional de nombres de sub-agentes a adjuntar al prompt (ej. ['explore', 'general'])",
        "resume": "boolean opcional (para synthetic/prompt: si debe reanudar ejecución inmediatamente)",
        "command_name": "string (obligatorio solo cuando as='command', ej. 'compact')",
        "wait": "boolean (opcional, por defecto false: si es true, espera a que termine el turno y devuelve la respuesta del asistente)",
        "timeout_ms": "number (opcional: timeout de espera cuando wait=true, por defecto 180000)"
      },
      "example": {
        "action": "openisy.send",
        "arguments": {
          "session_id": "active",
          "as": "user",
          "delivery": "steer",
          "text": "Lanza un sub-agente explore para verificar todos los usos de parseModelRef",
          "agents": ["explore"]
        }
      }
    },
    handler: async (args) => {
      const gate = checkGate("agent_spawn", "openisy.send", {
        session_id: String(args.session_id ?? "active"),
        as: String(args.as ?? "user"),
        text: String(args.text ?? args.prompt ?? ""),
      });
      if (!gate.ok) return { ok: false, result: null, error: gate.message };
      const { sendToOpenIsySession } = await import("../openisy-tunnel");
      const res = await sendToOpenIsySession(args);
      return { ok: true, result: res };
    },
  },
  {
    name: "openisy.control",
    family: "openisy",
    aliases: ["openisy.steer"],
    glossary: {
      "description": "Toma control de una sesión TUI de OpenISy en vivo: cambia el agente activo ('build', 'plan', 'general', 'explore'), cambia el modelo/provider en caliente, interrumpe el turno actual, aprueba/rechaza permisos bloqueados o inyecta variables de entorno / API keys en la sesión.",
      "parameters": {
        "session_id": "string (opcional: 'ses_...' o 'active'/'latest' por defecto)",
        "agent": "string (opcional: nuevo agente para la sesión, ej. 'build', 'plan', 'general', 'explore')",
        "model": "string o objeto (opcional: ej. 'xkiro/x-ai/grok-4.5', 'freellmapi/claude-sonnet-4-5' o { providerID, id, variant })",
        "provider": "string (opcional: providerID si 'model' solo lleva el id del modelo)",
        "interrupt": "boolean (opcional: true para interrumpir el turno en curso)",
        "approve_permissions": "enum opcional: 'once' | 'always' | 'reject' (responde permisos pendientes en la TUI)",
        "permission_id": "string (opcional: ID específico del permiso; si se omite, aplica a todos los pendientes de la sesión)",
        "env": "record opcional (variables de entorno o API keys a inyectar en el proceso de la sesión)"
      },
      "example": {
        "action": "openisy.control",
        "arguments": {
          "session_id": "active",
          "approve_permissions": "once",
          "model": "xkiro/anthropic/claude-sonnet-4.6"
        }
      }
    },
    handler: async (args) => {
      const gate = checkGate("agent_spawn", "openisy.control", {
        session_id: String(args.session_id ?? "active"),
        agent: args.agent ? String(args.agent) : undefined,
        model: args.model ? String(args.model) : undefined,
      });
      if (!gate.ok) return { ok: false, result: null, error: gate.message };
      const { controlOpenIsySession } = await import("../openisy-tunnel");
      const res = await controlOpenIsySession(args);
      return { ok: true, result: res };
    },
  },
  {
    name: "openisy.subagent",
    family: "openisy",
    aliases: ["subagent.run", "subagent.spawn", "openisy.spawn"],
    glossary: {
      "description": "Despacha un sub-agente desde AGY o cualquier otra TUI a través de OpenISy (con todas las tools locales: bash, ziggrep, edición, o solo lectura con agent='explore') o directamente contra un endpoint externo compatible con OpenAI. Permite elegir cualquier provider configurado ('freellmapi', 'xkiro', 'nvidia', 'isyco-web'), pasar API keys propias y colgar el sub-agente como hijo de la TUI principal.",
      "parameters": {
        "prompt": "string (obligatorio: tarea detallada para el sub-agente)",
        "agent": "string (opcional, por defecto 'general'; usa 'explore' para investigación rápida de solo lectura o 'plan' para arquitectura)",
        "model": "string (opcional: ej. 'xkiro/x-ai/grok-4.5', 'freellmapi/claude-sonnet-4-5', 'nvidia/mistralai/mistral-large-4-1t-a52b', 'isyco-web/chatgpt-web/gpt-5.6-sol')",
        "provider": "string (opcional: 'xkiro' | 'freellmapi' | 'nvidia' | 'isyco-web' si no va prefijado en model)",
        "variant": "string (opcional: ej. 'thinking' o 'default')",
        "parent_session_id": "string (opcional: 'ses_...' o 'active' para que el sub-agente aparezca como hijo dentro de tu TUI de OpenISy)",
        "attach_to_active": "boolean (opcional: si es true, cuelga automáticamente el sub-agente de la sesión activa en la TUI de OpenISy)",
        "cwd": "string (opcional: directorio de trabajo para el sub-agente)",
        "title": "string (opcional: título visible de la sesión del sub-agente)",
        "auto_approve": "boolean (opcional, por defecto true: pre-aprueba permisos en la sesión hija para que no se bloquee)",
        "wait": "boolean (opcional, por defecto true: espera a que el sub-agente termine y devuelve su respuesta completa; false lo deja corriendo en background)",
        "timeout_ms": "number (opcional: tiempo máximo de espera en ms cuando wait=true, por defecto 300000)",
        "api_key": "string (opcional: API key efímera para inyectar en la sesión o usar con direct_api=true)",
        "api_key_env": "string (opcional, por defecto 'OPENAI_API_KEY': nombre de la variable de entorno para api_key)",
        "env": "record opcional (variables de entorno adicionales para la sesión del sub-agente)",
        "direct_api": "boolean (opcional: si es true, llama directo por HTTP a base_url/chat/completions con api_key sin pasar por sesión de OpenISy)",
        "base_url": "string (opcional: URL base del provider externo cuando direct_api=true)"
      },
      "example": {
        "action": "openisy.subagent",
        "arguments": {
          "prompt": "Analiza la estructura de hub/src en chatgpt-http-mcp-hub y resume sus módulos en 5 puntos",
          "agent": "explore",
          "model": "xkiro/google/gemini-3.6-flash",
          "attach_to_active": true,
          "wait": true
        }
      }
    },
    handler: async (args) => {
      const gate = checkGate("agent_spawn", "openisy.subagent", {
        agent: String(args.agent ?? "general"),
        model: args.model ? String(args.model) : undefined,
        prompt: String(args.prompt ?? args.text ?? ""),
      });
      if (!gate.ok) return { ok: false, result: null, error: gate.message };
      const { runOpenIsySubagent } = await import("../openisy-tunnel");
      const res = await runOpenIsySubagent(args);
      return { ok: true, result: res };
    },
  },
  {
    name: "openswift.screenshot",
    family: "openswift",
    aliases: ["openswift.render", "openswift.preview", "iphone.simulator.screenshot", "simulator.screenshot"],
    describeAliases: ["openswift"],
    glossary: {
      "description": "Toma una captura de pantalla PNG del simulador de iPhone/iPad de OpenSwift a partir de un archivo .swift o código SwiftUI en línea, devolviendo la imagen visual en MCP + ruta del PNG en disco + árbol de vistas + diagnósticos.",
      "parameters": {
        "file": "string (opcional: ruta al archivo .swift, ej. 'examples/dashboard.swift'; alternativa a 'source')",
        "source": "string (opcional: código SwiftUI en línea si no se especifica 'file')",
        "device": "string (opcional, por defecto 'iphone-16-pro'): iphone-11..iphone-16-pro-max, ipad-10..ipad-pro-13, lista separada por comas o 'phones' | 'ipads' | 'all'",
        "appearance": "enum opcional: 'dark' | 'light' | 'both' (por defecto 'dark'; 'both' genera hoja comparativa oscuro + claro lado a lado)",
        "orientation": "enum opcional: 'portrait' | 'landscape' (por defecto 'portrait')",
        "frame": "enum opcional: 'black' | 'natural' | 'white' | 'blue' | 'none' (por defecto 'black')",
        "scale": "number (opcional: densidad Retina 1..3, por defecto 2)",
        "output": "string (opcional: ruta donde guardar el PNG generado)"
      },
      "example": {
        "action": "openswift.screenshot",
        "arguments": {
          "file": "examples/dashboard.swift",
          "device": "iphone-16-pro",
          "appearance": "both"
        }
      }
    },
    handler: async (args) => {
      const { captureOpenSwiftScreenshot } = await import("../openswift/service");
      const res = await captureOpenSwiftScreenshot({
        file: args.file ?? args.path,
        source: args.source ?? args.code,
        cwd: args.cwd,
        device: args.device,
        appearance: args.appearance,
        orientation: args.orientation,
        frame: args.frame,
        scale: args.scale,
        output: args.output,
        include_image: args.include_image !== false,
      });
      return { ok: res.ok, result: res.ok ? res : null, error: res.error };
    },
  },
  {
    name: "openswift.devices",
    family: "openswift",
    aliases: ["openswift.models"],
    glossary: {
      "description": "Lista todos los modelos de iPhone e iPad disponibles en el simulador de OpenSwift con sus dimensiones lógicas, tipo de notch/Dynamic Island, apariencias y carcasas.",
      "parameters": {},
      "example": {
        "action": "openswift.devices"
      }
    },
    handler: async () => {
      const { listOpenSwiftDevices } = await import("../openswift/service");
      const res = await listOpenSwiftDevices();
      return { ok: res.ok, result: res.ok ? res : null, error: res.error };
    },
  },
  {
    name: "handoff.load",
    family: "handoff",
    aliases: ["handoff.read", "agy.handoff", "handoff"],
    describeAliases: ["handoff"],
    glossary: {
      "description": "Carga en un solo paso el handoff compactado por NVIDIA Nemotron desde el Baúl junto con git status y coincidencias en vivo vía ziggrep sobre los símbolos clave.",
      "parameters": {
        "target": "string (opcional: prefijo de conversation_id o título; si se omite carga el más reciente del workspace)",
        "workspace": "string (opcional: ruta del repo/workspace donde correr ziggrep y git status)",
        "query": "string (opcional: términos adicionales separados por espacio/coma para ziggrep)",
        "max_matches": "number (opcional, por defecto 45): máximo de líneas ziggrep"
      },
      "example": {
        "action": "handoff.load",
        "arguments": {
          "target": "ab6bd0b4",
          "workspace": "/path/to/workspace"
        }
      }
    },
    handler: async (args) => {
      const { loadAgyHandoffContext } = await import("../handoff/service");
      const res = await loadAgyHandoffContext({
        target: args.target ? String(args.target) : undefined,
        workspace: args.workspace ? String(args.workspace) : undefined,
        query: args.query ? String(args.query) : undefined,
        max_matches: typeof args.max_matches === "number" ? args.max_matches : undefined,
        compacted_dir: args.compacted_dir ? String(args.compacted_dir) : undefined,
      });
      return { ok: res.ok, result: res.ok ? res : null, error: res.error };
    },
  },
  {
    name: "handoff.list",
    family: "handoff",
    aliases: ["handoff.vault"],
    glossary: {
      "description": "Lista los handoffs compactados disponibles en el Baúl de agy-dash (`compacted/`).",
      "parameters": {},
      "example": { "action": "handoff.list" }
    },
    handler: async (args) => {
      const { listCompactedVault } = await import("../handoff/service");
      const entries = listCompactedVault(args.compacted_dir ? String(args.compacted_dir) : undefined);
      return { ok: true, result: { count: entries.length, entries } };
    },
  },
  {
    name: "handoff.compact",
    family: "handoff",
    aliases: ["compactnvidia"],
    glossary: {
      "description": "Dispara la compactación NVIDIA NIM (Nemotron) de la sesión AGY en 2º plano mediante `agy-dash compact`.",
      "parameters": {
        "target": "string (opcional, por defecto 'self'): conversation_id o 'self'",
        "open": "boolean (opcional, por defecto true): abre nueva pestaña al terminar",
        "background": "boolean (opcional, por defecto true): corre en segundo plano"
      },
      "example": {
        "action": "handoff.compact",
        "arguments": { "target": "self", "open": true, "background": true }
      }
    },
    handler: async (args) => {
      const { triggerNvapiCompaction } = await import("../handoff/service");
      const res = await triggerNvapiCompaction({
        target: args.target ? String(args.target) : "self",
        open: args.open !== false,
        background: args.background !== false,
      });
      return { ok: res.ok, result: res.ok ? res : null, error: res.error };
    },
  },
  {
    name: "handoff.self_compact",
    family: "handoff",
    aliases: ["agy.self_compact", "self_compact"],
    glossary: {
      "description": "Dispara la auto-compactación de la propia conversación del agente con NVIDIA Nemotron 550B y continúa in-place en la misma pestaña de la TUI.",
      "parameters": {
        "conv_id": "string (opcional, por defecto 'self'): UUID o prefijo de la conversación actual",
        "cwd": "string (opcional): workspace de la sesión",
        "resume_prompt": "string (opcional): siguiente paso inmediato con el que debe continuar tras compactar",
        "model": "string (opcional): modelo NVIDIA NIM (default nvidia/nemotron-3-ultra-550b-a55b)",
        "in_place": "boolean (opcional, por defecto true): reemplaza la misma pestaña en agy-dash"
      },
      "example": {
        "action": "handoff.self_compact",
        "arguments": {
          "conv_id": "ab6bd0b4",
          "cwd": "/path/to/workspace",
          "resume_prompt": "Seguir con la suite de pruebas"
        }
      }
    },
    handler: async (args) => {
      const { triggerSelfCompact } = await import("../handoff/service");
      const res = await triggerSelfCompact({
        conv_id: args.conv_id ? String(args.conv_id) : (args.target ? String(args.target) : "self"),
        cwd: args.cwd ? String(args.cwd) : undefined,
        resume_prompt: args.resume_prompt ? String(args.resume_prompt) : undefined,
        model: args.model ? String(args.model) : undefined,
        in_place: args.in_place !== false,
        dryRun: args.dryRun === true || args.dry_run === true,
      });
      return { ok: res.ok, result: res.ok ? res : null, error: res.error };
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
