import {test,expect} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {MediaCatalog} from '../src/media/catalog';
import {run} from '../src/media/process';
import {CODEX_TOOLS} from '../src/mcp/identity';
test('Codex ISyMCP combines original tools with token-free registered media',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-unified-'));const file=join(root,'tone.wav');const home=join(root,'media');
 await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1',file]);
 const a=await new MediaCatalog(home).add(file);
 const client=new Client({name:'unified-smoke',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp/main.ts')],env:{...process.env,ISYMCP_MEDIA_HOME:home,CODEX_WEB_HTTP_HOME:join(root,'codex')} as Record<string,string>,stderr:'pipe'});transport.stderr?.on('data',()=>{});
 try {
  await client.connect(transport);const names=(await client.listTools()).tools.map(t=>t.name);
  for(const name of [...CODEX_TOOLS,'media_list','media_info','audio_analyze','audio_segments','video_frame','media_import','media_import_status','video_contact_sheet'])expect(names).toContain(name);
  const invalid:any=await client.callTool({name:'media_import',arguments:{url:'https://127.0.0.1/a'}});expect(invalid.isError).toBe(true);
  const list:any=await client.callTool({name:'media_list',arguments:{}});expect(list.isError).not.toBe(true);
  const payload=JSON.parse(list.content[0].text);expect(payload.assets[0].id).toBe(a.id);expect(list.content[0].text).not.toContain(root);
  const audio:any=await client.callTool({name:'audio_analyze',arguments:{asset_id:a.id,start_seconds:0,end_seconds:1}});expect(audio.isError).not.toBe(true);expect(audio.content.filter((c:any)=>c.type==='image')).toHaveLength(2);
  const segments:any=await client.callTool({name:'audio_segments',arguments:{asset_id:a.id,start_seconds:0,end_seconds:1}});expect(segments.isError).not.toBe(true);expect(JSON.parse(segments.content[0].text).result.segments).toHaveLength(1);
  const old:any=await client.callTool({name:'codex_exec',arguments:{turn_token:'unrecognized-token-length-24',command:['true']}});expect(JSON.parse(old.content[0].text).executed).toBe(false);
  const noToken:any=await client.callTool({name:'codex_exec',arguments:{command:['true']}});expect(noToken.isError).toBe(true);
 } finally {await client.close();}
},15000);
