// src/mcp/gateway.ts — Universal Gateway y Glosario de Herramientas para ISyMCP estilo REA.
import { z } from "zod";
import { FAMILY_DESCRIPTIONS, GATEWAY_ACTIONS, GLOSSARY_HEADER, PREFIX_FAMILIES, type GatewayAction, type GlossaryEntry } from "./gateway-actions";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawnAgentTui } from "../tui-launcher";
import { checkGate } from "../permissions";
import { insertTask, respondTask } from "../monitor/tasks";
import { join as joinPath } from "node:path";

import { GITHUB_MCP_TOOLS } from "../github/mcp-tools";
import { callGitHubApi } from "../github/client";
import { openBridgeMonitorStack } from "../remote-monitor";
import { ISYMCP_AGENT_PROTOCOL_MD } from "../agent-protocol";
import { executeShellCommand } from "../shell/executor";

export type { GlossaryEntry } from "./gateway-actions";

export interface GlossaryFamily {
  description: string;
  actions: Record<string, GlossaryEntry>;
}

/** Glosario generado del registro único (src/mcp/gateway-actions.ts), en el mismo orden de familias. */
export const ISYMCP_GLOSSARY: {
  isymcp_version: string;
  gateway: string;
  description: string;
  usage_instruction: string;
  families: Record<string, GlossaryFamily>;
} = {
  ...GLOSSARY_HEADER,
  families: Object.fromEntries(
    Object.entries(FAMILY_DESCRIPTIONS).map(([family, description]) => [
      family,
      { description, actions: Object.fromEntries(GATEWAY_ACTIONS.filter((a) => a.family === family).map((a) => [a.name, a.glossary])) },
    ]),
  ),
};

/** Acción por nombre o alias de despacho. */
function findAction(normalized: string): GatewayAction | undefined {
  return GATEWAY_ACTIONS.find((a) => a.name === normalized || a.aliases?.includes(normalized));
}

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

  // 2. Describe: contrato de una acción (por nombre, alias o atajo de documentación)
  if (normalized === "describe") {
    const rawTarget = String(args.name ?? args.action ?? "").trim().toLowerCase();
    const target = GATEWAY_ACTIONS.find((a) => a.name === rawTarget || a.aliases?.includes(rawTarget) || a.describeAliases?.includes(rawTarget));
    if (target) {
      return { ok: true, result: { action: target.name, family: target.family, ...target.glossary } };
    }
    return {
      ok: false,
      result: null,
      error: `Acción desconocida en el glosario: '${rawTarget}'. Invoca isymcp(action='glossary') para ver la lista completa.`,
    };
  }

  try {
    const found = findAction(normalized);
    if (found?.handler) return await found.handler(args, normalized);
    const family = PREFIX_FAMILIES.find((f) => f.matches(normalized));
    if (family) return await family.handler(args, normalized);
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
 * Integra metadatos oficiales del OpenAI Apps SDK (ui.resourceUri y openai/outputTemplate)
 * para proyectar el Control Center como Página Conectada nativa dentro de ChatGPT.
 */
export function registerControlCenterMcpTools(server: McpServer): void {
  // 1. isymcp_get_overview (Solo consulta de datos estructurados — sin metadata de renderizado)
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

  // 2. isymcp_get_glossary (Solo consulta de catálogo y contratos)
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

  // 3. isymcp_get_tasks (Solo consulta de tareas en SQLite WAL)
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

  // 4. isymcp_get_protocol (Solo consulta de documento de agentes)
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

  // 4b. Consolas TUI: identidad, PID real, ACK y log (solo lectura)
  server.registerTool(
    "isymcp_get_consoles",
    {
      description:
        "Lista las consolas TUI (Antigravity) lanzadas: console_id, PID real del agente, alive, estado, token_fp, task_id y ACK firmado. Úsala para no confundir consolas. Solo lectura.",
      inputSchema: { limit: z.number().optional().default(20).describe("Máximo de consolas (por defecto 20)") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const r = await dispatchIsyMcpAction("tui.consoles", { limit: input.limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(r.result ?? { error: r.error }, null, 2) }], isError: !r.ok };
    },
  );
  server.registerTool(
    "isymcp_get_console_log",
    {
      description: "Log cronológico de una consola TUI concreta (por console_id o task_id). Solo lectura.",
      inputSchema: {
        console_id: z.string().describe("console_id (con-xxxxxxxx) o task_id"),
        tail: z.number().optional().default(50).describe("Últimos N eventos (por defecto 50)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const r = await dispatchIsyMcpAction("tui.log", { console_id: input.console_id, tail: input.tail });
      return { content: [{ type: "text" as const, text: JSON.stringify(r.result ?? { error: r.error }, null, 2) }], isError: !r.ok };
    },
  );

  // 5. isymcp_open_control_center (Herramienta lanzadora oficial OpenAI Apps SDK / Sidebar & Thread Entrypoint)
  server.registerTool(
    "isymcp_open_control_center",
    {
      description:
        "Abre y proyecta la interfaz interactiva de ISyMCP Control Center en ChatGPT como Página Conectada / Apps SDK View.",
      inputSchema: {
        tab: z
          .enum(["dashboard", "cli", "catalog", "monitor", "tui", "github", "media", "comfy", "fuzz"])
          .optional()
          .default("dashboard")
          .describe("Pestaña inicial a enfocar en el Control Center"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      return {
        content: [
          {
            type: "text" as const,
            text: `ISyMCP Control Center desplegado en la vista interactiva de ChatGPT (pestaña solicitada: ${input.tab}).`,
          },
        ],
        _meta: {
          ui: {
            resourceUri: "ui://isymcp/control-center",
          },
          "ui.resourceUri": "ui://isymcp/control-center",
          "openai/outputTemplate": "ui://isymcp/control-center",
          "openai/ui": {
            entrypoints: [
              { type: "global" },
              { type: "thread" },
            ],
          },
          "ui.visibility": ["model", "app"],
          "ui.initialTab": input.tab,
        },
      };
    }
  );
}
