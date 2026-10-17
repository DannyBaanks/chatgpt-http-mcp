import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendTrace } from '../tool-trace';
import { MediaService } from './service';

/**
 * Envuelve el handler de una tool de medios para dejar evidencia independiente
 * en `mcp-trace.log` (tool, call_id, ok, error_code, error, state). Sin token:
 * las tools de medios no piden turn_token, asi que estos eventos no aparecen en
 * la vista por sesion (que filtra por token_fp) pero si son evidencia local.
 */
function traced(service: MediaService, tool: string) {
 return async (input: Record<string, unknown>): Promise<any> => {
  const callId = randomUUID();
  appendTrace('call', { tool, call_id: callId });
  const result = await service.call(tool, input);
  const failed = (result as { isError?: boolean }).isError === true;
  try {
   const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
   const r = JSON.parse(text) as Record<string, unknown>;
   appendTrace('tool.result', {
    tool,
    call_id: callId,
    ok: !failed && r.error === undefined,
    error_code: typeof r.error_code === 'string' ? r.error_code : undefined,
    error: typeof r.error === 'string' ? r.error : undefined,
    state: typeof r.state === 'string' ? r.state : undefined,
   });
  } catch {
   /* la traza nunca rompe la tool */
  }
  return result;
 };
}

export function registerMediaTools(server:McpServer, service=new MediaService()) {
 server.registerTool('media_import',{
  description:'Descarga un video público de YouTube/Shorts en la PC del usuario y lo registra para análisis local. Solo úsala cuando el usuario solicite importar/analizar ese enlace. Devuelve job_id rápidamente: consulta media_import_status hasta complete antes de usar asset.id. Sin cookies; máximo 500 MiB, 30 minutos, plazo 180 segundos.',
  inputSchema:{url:z.string().url().max(2048)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
 },traced(service,'media_import'));
 server.registerTool('media_import_status',{
  description:'Consulta un trabajo de descarga local. wait_seconds permite esperar hasta 10 segundos por progreso. Cuando state es complete, usa asset.id con media_info, audio_analyze o video_frame. Si failed, informa error_code y message; no supongas que se analizó el video.',
  inputSchema:{job_id:z.string().regex(/^import_[a-f0-9-]{36}$/),wait_seconds:z.number().int().min(0).max(10).optional()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
 },traced(service,'media_import_status'));
 const asset_id=z.string().regex(/^media_[a-f0-9-]{36}$/).describe('ID devuelto por media_list o isymcp media add; nunca una ruta');
 const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
 server.registerTool('media_list',{
  description:'Lista solo archivos de audio/video registrados explícitamente por el usuario. No requiere turn_token ni explora el disco. Devuelve IDs para las herramientas de medios.',
  inputSchema:{offset:z.number().int().min(0).optional()},annotations,
 },traced(service,'media_list'));
 server.registerTool('media_lookup',{
  description:'Busca una URL pública de YouTube/Shorts entre medios registrados y preparados localmente. Es de solo lectura: nunca descarga ni analiza. Devuelve manifiesto y audio_scan completos; con sheet_index devuelve como máximo una hoja JPEG guardada. Si no está preparado, informa not_prepared para que el usuario use isymcp media prepare <url>. No expone rutas locales.',
  inputSchema:{url:z.string().url().max(2048),sheet_index:z.number().int().min(0).optional()},annotations,
 },traced(service,'media_lookup'));
 server.registerTool('media_info',{
  description:'Inspecciona duración y streams de un medio local registrado. No requiere turn_token.',
  inputSchema:{asset_id},annotations,
 },traced(service,'media_info'));
 server.registerTool('audio_analyze',{
  description:'Procesa localmente hasta 120 segundos: RMS, picos, silencios, onda y espectrograma con zoom temporal. Para cubrir una pista larga, usa audio_scan. channel=left/right inspecciona un canal; separate devuelve onda/espectrograma L/R y correlación/diferencia entre canales; mix conserva la mezcla mono predeterminada. La comparación no separa fuentes. Son mediciones acústicas, no escucha nativa ni transcripción.',
  inputSchema:{asset_id,start_seconds:z.number().finite().min(0),end_seconds:z.number().finite().min(0),channel:z.enum(['mix','left','right','separate']).optional()},annotations,
 },traced(service,'audio_analyze'));
 server.registerTool('audio_segments',{
  description:'Detecta segmentos de actividad acústica en una ventana de hasta 120 segundos con RMS cada 10 ms sobre audio mono a 16 kHz; no reconoce habla. Devuelve tiempos, RMS y pico. Para analizar la pista completa, usa audio_scan. Ajusta threshold_dbfs, merge_gap_seconds y min_segment_seconds; después usa audio_analyze sobre un intervalo para ampliar la onda y el espectrograma.',
  inputSchema:{asset_id,start_seconds:z.number().finite().min(0),end_seconds:z.number().finite().min(0),threshold_dbfs:z.number().finite().min(-80).max(-5).optional(),merge_gap_seconds:z.number().finite().min(0).max(2).optional(),min_segment_seconds:z.number().finite().min(0.02).max(10).optional()},annotations,
 },traced(service,'audio_segments'));
 server.registerTool('audio_scan',{
  description:'Analiza por completo el audio local registrado, desde 0 hasta su duración por defecto. Lo recorre en orden en bloques de hasta 120 segundos y devuelve segmentos de actividad con tiempos absolutos; chunk_seconds puede reducir el tamaño (1–120 s). Sin transcripción ni escucha nativa: detecta energía acústica, no palabras ni voces. Usa audio_analyze después para inspeccionar onda/espectrograma de un tramo de hasta 120 s.',
  inputSchema:{asset_id,start_seconds:z.number().finite().min(0).optional(),end_seconds:z.number().finite().min(0).optional(),chunk_seconds:z.number().finite().min(1).max(120).optional(),threshold_dbfs:z.number().finite().min(-80).max(-5).optional(),merge_gap_seconds:z.number().finite().min(0).max(2).optional(),min_segment_seconds:z.number().finite().min(0.02).max(10).optional()},annotations,
 },traced(service,'audio_scan'));
 server.registerTool('video_contact_sheet',{
  description:'Genera localmente una sola hoja de contacto JPEG de 1920x1080, con fotogramas ordenados y tiempos solicitados. Cuadrícula 4x4 por defecto (16 imágenes); 3x3 o 6x6 opcionales. Intervalo de hasta 60 segundos. Úsala para explorar la secuencia y después pide video_frame para detalles. No equivale a reproducir una animación.',
  inputSchema:{asset_id,start_seconds:z.number().finite().min(0),end_seconds:z.number().finite().min(0),columns:z.union([z.literal(3),z.literal(4),z.literal(6)]).optional()},annotations,
 },traced(service,'video_contact_sheet'));
 server.registerTool('video_frame',{
  description:'Devuelve un fotograma real de un video local registrado usando Video Vision. No requiere turn_token.',
  inputSchema:{asset_id,timestamp_seconds:z.number().finite().min(0)},annotations,
 },traced(service,'video_frame'));
}
