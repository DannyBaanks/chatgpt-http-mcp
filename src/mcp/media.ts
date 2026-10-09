import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMediaTools } from '../media/register';
const server=new McpServer({name:'isymcp-media',version:'1.1.0'},{instructions:'Procesa medios locales explícitamente registrados. Usa media_list para descubrir IDs; no necesitas un turno Codex. Los gráficos no equivalen a escuchar audio nativo.'});
registerMediaTools(server);
await server.connect(new StdioServerTransport());
