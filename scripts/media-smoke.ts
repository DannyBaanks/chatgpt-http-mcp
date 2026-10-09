import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const client=new Client({name:'isymcp-media-smoke',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp/media.ts')],env:process.env as Record<string,string>});
try {
 await client.connect(transport);
 const ids=process.argv.slice(2); if(ids.length!==2) throw Error('Usage: bun scripts/media-smoke.ts <video_id> <audio_id>');
 const summaries=[];
 for(const [name,args] of [['video_frame',{asset_id:ids[0],timestamp_seconds:5}],['audio_analyze',{asset_id:ids[1],start_seconds:0,end_seconds:10}]] as const) {
  const result:any=await client.callTool({name,arguments:args});if(result.isError) throw Error(result.content[0].text);
  let index=0; for(const content of result.content) if(content.type==='image'){const bytes=Buffer.from(content.data,'base64');writeFileSync(join('/tmp',`isymcp-${name}-${index++}.${content.mimeType==='image/png'?'png':'jpg'}`),bytes,{mode:0o600});}
  summaries.push({tool:name,metadata:JSON.parse(result.content[0].text),images:result.content.filter((c:any)=>c.type==='image').map((c:any)=>({mimeType:c.mimeType,bytes:Buffer.from(c.data,'base64').length}))});
 }
 console.log(JSON.stringify(summaries,null,2));
} finally {await client.close();}
