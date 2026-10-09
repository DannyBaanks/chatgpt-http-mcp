import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const client=new Client({name:'url-media-smoke',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp/main.ts')],env:process.env as Record<string,string>,stderr:'pipe'});transport.stderr?.on('data',()=>{});
async function call(name:string,args:Record<string,unknown>) {
 const result:any=await client.callTool({name,arguments:args});
 const payload=JSON.parse(result.content[0].text);if(result.isError)throw Error(JSON.stringify(payload));return {result,payload};
}
try {
 await client.connect(transport);
 const url=process.argv[2];if(!url)throw Error('Usage: bun scripts/media-import-smoke.ts <YouTube URL>');
 const first=await call('media_import',{url});console.log(JSON.stringify({event:'import_started',...first.payload}));
 let status=first.payload;
 while(status.state==='running'){status=(await call('media_import_status',{job_id:status.job_id,wait_seconds:10})).payload;console.log(JSON.stringify({event:'import_status',...status}));}
 if(status.state!=='complete')throw Error('Import not complete');
 const id=status.asset.id;const info=(await call('media_info',{asset_id:id})).payload;console.log(JSON.stringify({event:'media_info',...info}));
 for(const [name,args] of [['audio_analyze',{asset_id:id,start_seconds:0,end_seconds:Math.min(10,info.result.duration_seconds)}],['video_frame',{asset_id:id,timestamp_seconds:5}]] as const){
  const {result,payload}=await call(name,args);let index=0;
  const images=result.content.filter((c:any)=>c.type==='image').map((c:any)=>{const bytes=Buffer.from(c.data,'base64');const path=join('/tmp',`isymcp-import-${name}-${index++}.${c.mimeType==='image/png'?'png':'jpg'}`);writeFileSync(path,bytes,{mode:0o600});return {mimeType:c.mimeType,bytes:bytes.length,path};});
  console.log(JSON.stringify({event:name,metadata:payload,images}));
 }
}finally{await client.close();}
