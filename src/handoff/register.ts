// src/handoff/register.ts — Tool MCP discreta `agy_handoff_context` para cargar handoff + ziggrep en 1 llamada.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadAgyHandoffContext, triggerSelfCompact, waitForHandoffDelivery } from "./service";

export function registerHandoffTools(server: McpServer): void {
  server.registerTool(
    "agy_handoff_context",
    {
      description:
        "Carga en UN SOLO comando el handoff compactado por NVIDIA Nemotron desde el Baúl (`~/.gemini/antigravity-cli/compacted/`) junto con la verificación viva de archivos, estado git y búsqueda `ziggrep` de los símbolos clave en el workspace.",
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe("Prefijo de conversation_id (ej. 'ab6bd0b4') o título de la sesión compactada; si se omite, carga la más reciente del workspace."),
        workspace: z
          .string()
          .optional()
          .describe("Ruta del workspace donde ejecutar ziggrep y consultar git status."),
        query: z
          .string()
          .optional()
          .describe("Términos o símbolos adicionales separados por espacio/coma para buscar con ziggrep junto con los extraídos del handoff."),
        max_matches: z
          .number()
          .int()
          .min(5)
          .max(120)
          .optional()
          .default(45)
          .describe("Máximo de líneas de coincidencia de ziggrep a incluir (por defecto 45)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const res = await loadAgyHandoffContext({
        target: input.target,
        workspace: input.workspace,
        query: input.query,
        max_matches: input.max_matches,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }],
        isError: !res.ok,
      };
    },
  );

  server.registerTool(
    "agy_self_compact",
    {
      description:
        "Permite que el propio agente compacte su conversación actual con NVIDIA Nemotron 550B (NVAPI) cuando el heartbeat de contexto indica un rango alto, y continúe automáticamente in-place en la misma pestaña de la TUI cargando el handoff + ziggrep.",
      inputSchema: {
        conv_id: z
          .string()
          .optional()
          .describe("UUID o prefijo de la conversación actual (o 'self' para autodetectarla)."),
        cwd: z
          .string()
          .optional()
          .describe("Directorio de trabajo de la sesión actual."),
        resume_prompt: z
          .string()
          .optional()
          .describe("Instrucción breve exacta de qué tarea inmediata continuar tras compactar."),
        model: z
          .string()
          .optional()
          .describe("Modelo NVIDIA NIM a usar (por defecto 'nvidia/nemotron-3-ultra-550b-a55b')."),
        in_place: z
          .boolean()
          .optional()
          .default(true)
          .describe("true (por defecto): reemplaza in-place la misma pestaña de agy-dash para continuar ahí mismo."),
        wait: z
          .boolean()
          .optional()
          .default(true)
          .describe("true (por defecto): espera con monitor de archivo hasta que Nemotron entregue el handoff y despierta automáticamente al agente."),
        wait_timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(180000)
          .optional()
          .default(120000)
          .describe("Tiempo máximo de espera del monitor en ms (por defecto 120000)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const res = await triggerSelfCompact({
        conv_id: input.conv_id,
        cwd: input.cwd,
        resume_prompt: input.resume_prompt,
        model: input.model,
        in_place: input.in_place,
        wait: input.wait,
        wait_timeout_ms: input.wait_timeout_ms,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }],
        isError: !res.ok,
      };
    },
  );

  server.registerTool(
    "agy_wait_handoff",
    {
      description:
        "Monitor reactivo que observa `~/.gemini/antigravity-cli/compacted/` y despierta al agente automáticamente en cuanto Nemotron entrega `<id>_handoff.md`.",
      inputSchema: {
        target: z.string().describe("UUID o prefijo de 8 caracteres de la sesión compactada."),
        timeout_ms: z.number().int().min(500).max(180000).optional().default(120000),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const res = await waitForHandoffDelivery({
        short_id: input.target,
        timeout_ms: input.timeout_ms,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }],
        isError: !res.ok,
      };
    },
  );
}
