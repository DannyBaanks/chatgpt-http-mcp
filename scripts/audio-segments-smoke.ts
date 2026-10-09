import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const client=new Client({name:'audio-segments-smoke',version:'1'});
const entry=process.env.ISYMCP_MEDIA_MCP_ENTRY||join(import.meta.dir,'../src/mcp/main.ts');
const transport=new StdioClientTransport({command:process.execPath,args:[entry],env:process.env as Record<string,string>,stderr:'pipe'});
transport.stderr?.on('data',()=>{});
async function call(name:string,args:Record<string,unknown>){const result:any=await client.callTool({name,arguments:args});if(result.isError)throw Error(result.content[0]?.text||`${name} failed`);return result;}
try{
 const assetId=process.argv[2];if(!assetId)throw Error('Usage: bun scripts/audio-segments-smoke.ts <asset_id>');
 await client.connect(transport);
 const info=await call('media_info',{asset_id:assetId});
 const baseline=await call('audio_analyze',{asset_id:assetId,start_seconds:0,end_seconds:10,channel:'mix'});
 const segments=await call('audio_segments',{asset_id:assetId,start_seconds:0,end_seconds:10});
 const separate=await call('audio_analyze',{asset_id:assetId,start_seconds:3,end_seconds:5,channel:'separate'});
 let index=0;const images=[];
 for(const image of baseline.content.filter((item:any)=>item.type==='image')){const path=join('/tmp',`isymcp-audio-mix-${index}.png`);const bytes=Buffer.from(image.data,'base64');writeFileSync(path,bytes,{mode:0o600});images.push({path,bytes:bytes.length,channel:'mono mix'});index++;}
 index=0;
 for(const image of separate.content.filter((item:any)=>item.type==='image')){const path=join('/tmp',`isymcp-audio-segments-${index}.png`);const bytes=Buffer.from(image.data,'base64');writeFileSync(path,bytes,{mode:0o600});images.push({path,bytes:bytes.length});index++;}
 console.log(JSON.stringify({asset_id:assetId,media_info:JSON.parse(info.content[0].text),audio_analyze_mix_baseline:JSON.parse(baseline.content[0].text),audio_segments:JSON.parse(segments.content[0].text),audio_analyze_separate:JSON.parse(separate.content[0].text),images},null,2));
}finally{await client.close();}
