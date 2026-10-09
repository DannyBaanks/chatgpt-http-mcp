import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MediaService } from './service';
export function registerMediaTools(server:McpServer, service=new MediaService()) {
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
