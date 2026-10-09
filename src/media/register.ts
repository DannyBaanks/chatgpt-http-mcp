import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MediaService } from './service';
export function registerMediaTools(server:McpServer, service=new MediaService()) {
 server.registerTool('media_import',{
  description:'Descarga un video público de YouTube/Shorts en la PC del usuario y lo registra para análisis local. Solo úsala cuando el usuario solicite importar/analizar ese enlace. Devuelve job_id rápidamente: consulta media_import_status hasta complete antes de usar asset.id. Sin cookies; máximo 500 MiB, 30 minutos, plazo 180 segundos.',
  inputSchema:{url:z.string().url().max(2048)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
 },async input=>service.call('media_import',input));
 server.registerTool('media_import_status',{
  description:'Consulta un trabajo de descarga local. wait_seconds permite esperar hasta 10 segundos por progreso. Cuando state es complete, usa asset.id con media_info, audio_analyze o video_frame. Si failed, informa el error; no supongas que se analizó el video.',
  inputSchema:{job_id:z.string().regex(/^import_[a-f0-9-]{36}$/),wait_seconds:z.number().int().min(0).max(10).optional()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
 },async input=>service.call('media_import_status',input));
 const asset_id=z.string().regex(/^media_[a-f0-9-]{36}$/).describe('ID devuelto por media_list o isymcp media add; nunca una ruta');
 const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
 server.registerTool('media_list',{
  description:'Lista solo archivos de audio/video registrados explícitamente por el usuario. No requiere turn_token ni explora el disco. Devuelve IDs para las herramientas de medios.',
  inputSchema:{offset:z.number().int().min(0).optional()},annotations,
 },async input=>service.call('media_list',input));
 server.registerTool('media_info',{
  description:'Inspecciona duración y streams de un medio local registrado. No requiere turn_token.',
  inputSchema:{asset_id},annotations,
 },async input=>service.call('media_info',input));
 server.registerTool('audio_analyze',{
  description:'Procesa localmente hasta 60 segundos: RMS, picos, silencios, onda y espectrograma. Son mediciones acústicas, no escucha nativa. No requiere turn_token.',
  inputSchema:{asset_id,start_seconds:z.number().finite().min(0),end_seconds:z.number().finite().min(0)},annotations,
 },async input=>service.call('audio_analyze',input));
 server.registerTool('video_frame',{
  description:'Devuelve un fotograma real de un video local registrado usando Video Vision. No requiere turn_token.',
  inputSchema:{asset_id,timestamp_seconds:z.number().finite().min(0)},annotations,
 },async input=>service.call('video_frame',input));
}
