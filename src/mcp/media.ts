import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMediaTools } from '../media/register';
import { registerComfyTools } from '../comfyui/register';
import { serverIcon } from './icon';
const server=new McpServer({name:'isymcp-media',version:'1.1.0',icons:[serverIcon()]},{instructions:'Procesa medios locales explícitamente registrados y genera imágenes con workflows ComfyUI configurados por el usuario. Usa media_list o comfyui_workflows para descubrir IDs; no necesitas un turno Codex.'});
registerMediaTools(server);
registerComfyTools(server);
await server.connect(new StdioServerTransport());
