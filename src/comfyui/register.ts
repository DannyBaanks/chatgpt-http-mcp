import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendTrace } from '../tool-trace';
import { ComfyService } from './service';

function traced(service: ComfyService, tool: string) {
  return async (input: Record<string, unknown>): Promise<any> => {
    const callId = randomUUID();
    appendTrace('call', { tool, call_id: callId });
    const result = await service.call(tool, input);
    try {
      const text = result.content.find((part: { type: string; text?: string }) => part.type === 'text')?.text ?? '{}';
      const payload = JSON.parse(text) as Record<string, unknown>;
      appendTrace('tool.result', {
        tool,
        call_id: callId,
        ok: result.isError !== true,
        error_code: typeof payload.error_code === 'string' ? payload.error_code : undefined,
        state: typeof payload.state === 'string' ? payload.state : undefined,
      });
    } catch { /* tracing never breaks the tool result */ }
    return result;
  };
}

export function registerComfyTools(server: McpServer, service = new ComfyService()): void {
  const workflowId = z.string().regex(/^workflow_[a-f0-9-]{36}$/);
  const assetId = z.string().regex(/^creative_[a-f0-9]{64}$/);
  const jobId = z.string().regex(/^creativejob_[a-f0-9-]{36}$/);
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool('comfyui_status', {
    description: 'Comprueba si la instancia local de ComfyUI está disponible y devuelve su versión. No inicia el servicio.',
    inputSchema: {},
    annotations: readOnly,
  }, traced(service, 'comfyui_status'));

  server.registerTool('comfyui_workflows', {
    description:
      ('Lista los workflows API registrados explícitamente con isymcp comfy workflow add. Devuelve IDs, hashes y nombres de entradas configurables;' +
        ' no enumera archivos del disco.'),
    inputSchema: {},
    annotations: readOnly,
  }, traced(service, 'comfyui_workflows'));

  server.registerTool('comfyui_generate', {
    description:
      ('Genera imágenes solo cuando el usuario lo pide. El workflow debe estar registrado y cada entrada se valida contra su configuración local. Devuelve ' +
        'job_id; consulta comfyui_job_status hasta que termine y luego creative_asset_get para ver la imagen.'),
    inputSchema: { workflow_id: workflowId, inputs: z.record(z.string(), z.unknown()).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, traced(service, 'comfyui_generate'));

  server.registerTool('comfyui_job_status', {
    description:
      ('Consulta el estado de una generación local. wait_seconds puede esperar hasta 10 segundos por WebSocket; al completar devuelve IDs y hashes de ' +
        'artefactos.'),
    inputSchema: { job_id: jobId, wait_seconds: z.number().int().min(0).max(10).optional() },
    annotations: readOnly,
  }, traced(service, 'comfyui_job_status'));

  server.registerTool('creative_asset_get', {
    description: 'Lee y verifica un artefacto de imagen generado localmente. Devuelve sus metadatos y una vista previa MCP; no expone la ruta del archivo.',
    inputSchema: { asset_id: assetId },
    annotations: readOnly,
  }, traced(service, 'creative_asset_get'));
}
