import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { registerMediaTools } from '../media/register';
const icon = readFileSync(new URL('../../assets/isymcp-icon.png', import.meta.url)).toString('base64');
const server=new McpServer({name:'isymcp-media',version:'1.1.0',icons:[{src:`data:image/png;base64,${icon}`,mimeType:'image/png',sizes:['256x256']}]},{instructions:'Procesa medios locales explícitamente registrados. Usa media_list para descubrir IDs; no necesitas un turno Codex. Los gráficos no equivalen a escuchar audio nativo.'});
registerMediaTools(server);
await server.connect(new StdioServerTransport());
