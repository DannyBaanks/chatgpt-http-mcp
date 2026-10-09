import { remaining, signal } from './deadline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
export function frameResult(result:any) {
 if(result.isError) throw Error('Video Vision reported an error');
 const images=(result.content||[]).filter((c:any)=>c.type==='image');
 if(images.length!==1) throw Error('Video Vision did not return exactly one image');
 const i=images[0];
 if(!['image/jpeg','image/png'].includes(i.mimeType)||typeof i.data!=='string'||i.data.length>1398104) throw Error('Video Vision image exceeds limits or has invalid MIME');
 const bytes=Buffer.from(i.data,'base64');
 if(bytes.length>1024*1024||!(i.mimeType==='image/jpeg'?bytes.subarray(0,3).equals(Buffer.from([255,216,255])):bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))) throw Error('Invalid Video Vision image');
 return {type:'image' as const,mimeType:i.mimeType,data:i.data};
}
export async function videoFrame(path:string,timestamp:number) {
 const entry=process.env.ISYMCP_VIDEO_VISION_ENTRY;
 if(!entry||!isAbsolute(entry)||!existsSync(entry)) throw Error('Configure ISYMCP_VIDEO_VISION_ENTRY with the installed Video Vision dist/index.js');
 const client=new Client({name:'isymcp-media-provider',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.env.ISYMCP_VIDEO_VISION_NODE||'node',args:[entry],stderr:'pipe',maxBufferSize:2*1024*1024});
 // Drain provider diagnostics without contaminating the MCP stdout protocol.
 transport.stderr?.on('data',()=>{});
 const abort=()=>{void transport.close();}; const cancellation=signal(); cancellation?.addEventListener('abort',abort,{once:true});
 const timeout=setTimeout(abort,remaining());
 try {
  await client.connect(transport,{timeout:remaining()});
  return frameResult(await client.callTool({name:'extract_frame_at',arguments:{source:path,timestamp:String(timestamp),max_width:640} },undefined,{timeout:remaining()}));
 } finally {clearTimeout(timeout);cancellation?.removeEventListener('abort',abort);await client.close();}
}
