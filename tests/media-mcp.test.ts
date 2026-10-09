import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MediaCatalog} from '../src/media/catalog';
import {MediaService} from '../src/media/service';
import {MediaPreparationStore} from '../src/media/preparation-store';
import {prepareMedia} from '../src/media/preparation';
import {frameResult} from '../src/media/video-vision';
import {run} from '../src/media/process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('provider rejects semantic errors, oversize and fake images',()=>{
 expect(()=>frameResult({content:[{type:'text',text:'error'}]})).toThrow();
 expect(()=>frameResult({isError:true,content:[]})).toThrow();
 expect(()=>frameResult({content:[{type:'image',mimeType:'image/jpeg',data:'a'.repeat(1398105)}]})).toThrow();
 expect(()=>frameResult({content:[{type:'image',mimeType:'image/png',data:'AAAA'}]})).toThrow();
});
test('snapshot enforces revocation during work; service rejects overlap',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-mcp-'));const c=new MediaCatalog(join(root,'state'));const file=join(root,'a.wav');writeFileSync(file,'test');const a=await c.add(file);
 await expect(c.snapshot(a.id,async()=>{c.revoke(a.id);return 'x';})).rejects.toThrow('revoked');
 const b=await c.add(file);const service=new MediaService(c);const first=service.call('media_info',{asset_id:b.id});const second=await service.call('media_info',{asset_id:b.id});expect(second.isError).toBe(true);expect(second.content[0].text).toContain('busy');await first;
});
test('media lookup distinguishes not-found/unprepared/ready and returns at most the selected verified sheet',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-lookup-')),home=join(root,'state');const catalog=new MediaCatalog(home),service=new MediaService(catalog);
 const url='https://www.youtube.com/watch?v=abcdefghijk';
 const unknown:any=await service.call('media_lookup',{url});expect(JSON.parse(unknown.content[0].text)).toMatchObject({found:false,status:'not_found'});
 const audio=join(root,'audio.wav');await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2',audio]);
 const registered=await catalog.add(audio,url);const store=new MediaPreparationStore(home);
 const unprepared:any=await service.call('media_lookup',{url});expect(JSON.parse(unprepared.content[0].text)).toMatchObject({found:true,status:'not_prepared',asset_id:registered.id});
 expect(store.current(registered.id)).toBeUndefined();

 const video=join(root,'source.mp4');await run('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:s=128x72:r=8:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-map','0:v','-map','1:a','-c:v','mpeg4','-c:a','aac','-shortest',video]);
 const ready=await catalog.add(video,url);const manifest=await prepareMedia(catalog,ready,store);
 const listed:any=await service.call('media_lookup',{url});const payload=JSON.parse(listed.content[0].text);
 expect(payload).toMatchObject({found:true,status:'ready',asset_id:ready.id,source_url:url,source_sha256:ready.sha256});
 expect(payload.audio_scan.chunk_count).toBe(1);expect(payload.sheets).toHaveLength(1);
 expect(listed.content.filter((part:any)=>part.type==='image')).toHaveLength(0);
 expect(listed.content[0].text).not.toContain(root);
 const one:any=await service.call('media_lookup',{url,sheet_index:0});expect(JSON.parse(one.content[0].text).selected_sheet.index).toBe(0);
 expect(one.content.filter((part:any)=>part.type==='image')).toHaveLength(1);
 expect(Buffer.from(one.content.find((part:any)=>part.type==='image').data,'base64').subarray(0,3).toString('hex')).toBe('ffd8ff');
 expect(one.content[0].text).not.toContain(root);
 const invalid:any=await service.call('media_lookup',{url,sheet_index:1});expect(invalid.isError).toBe(true);
 expect(manifest.generation_id).toBe(payload.generation_id);
});
test('media lookup rejects invalid URLs, revoked assets and changed source bytes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-lookup-invalid-')),home=join(root,'state');const catalog=new MediaCatalog(home),service=new MediaService(catalog);
 const invalid:any=await service.call('media_lookup',{url:'http://127.0.0.1/private'});expect(invalid.isError).toBe(true);
 const file=join(root,'a.wav');writeFileSync(file,'audio bytes');const url='https://www.youtube.com/watch?v=abcdefghijk';const asset=await catalog.add(file,url);
 const stale:any=await service.call('media_lookup',{url});expect(JSON.parse(stale.content[0].text).status).toBe('not_prepared');
 writeFileSync(file,'changed bytes');const changed:any=await service.call('media_lookup',{url});expect(changed.isError).toBe(true);
 catalog.revoke(asset.id);const revoked:any=await service.call('media_lookup',{url});expect(JSON.parse(revoked.content[0].text)).toMatchObject({found:false,status:'not_found'});
 expect(JSON.stringify([changed,revoked])).not.toContain(root);
});
test('real MCP stdio returns info and two inline audio images',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-stdio-'));const file=join(root,'tone.wav');
 await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=1000:duration=1',file]);
 const home=join(root,'state');const a=await new MediaCatalog(home).add(file);
 const client=new Client({name:'media-smoke',version:'1'});const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp/media.ts')],env:{...process.env,ISYMCP_MEDIA_HOME:home} as Record<string,string>});
 try {await client.connect(transport);const toolNames=(await client.listTools()).tools.map(t=>t.name);expect(toolNames).toContain('media_list');expect(toolNames).toContain('audio_scan');expect(toolNames).toContain('media_lookup');
 const lookup:any=await client.callTool({name:'media_lookup',arguments:{url:'https://www.youtube.com/watch?v=abcdefghijk'}});expect(lookup.isError).not.toBe(true);expect(JSON.parse(lookup.content[0].text)).toMatchObject({found:false,status:'not_found'});
 const info:any=await client.callTool({name:'media_info',arguments:{asset_id:a.id}});expect(info.isError).not.toBe(true);
 const audio:any=await client.callTool({name:'audio_analyze',arguments:{asset_id:a.id,start_seconds:0,end_seconds:1}});expect(audio.isError).not.toBe(true);expect(audio.content.filter((c:any)=>c.type==='image').length).toBe(2);
 const stereoFile=join(root,'stereo.wav');await run('ffmpeg',['-v','error','-f','lavfi','-i','aevalsrc=0.5*sin(2*PI*440*t)|0.25*sin(2*PI*440*t):s=16000:d=1','-c:a','pcm_f32le',stereoFile]);
 const stereo=await new MediaCatalog(home).add(stereoFile);const stereoAudio:any=await client.callTool({name:'audio_analyze',arguments:{asset_id:stereo.id,start_seconds:0,end_seconds:1,channel:'separate'}});
 expect(stereoAudio.isError).not.toBe(true);expect(JSON.parse(stereoAudio.content[0].text).result.channel_comparison.pearson_correlation).toBeCloseTo(1,5);expect(stereoAudio.content.filter((c:any)=>c.type==='image').length).toBe(4);
 const segments:any=await client.callTool({name:'audio_segments',arguments:{asset_id:a.id,start_seconds:0,end_seconds:1}});expect(segments.isError).not.toBe(true);expect(JSON.parse(segments.content[0].text).result.algorithm_version).toBe('audio-rms-activity/2');expect(JSON.parse(segments.content[0].text).result.segments).toHaveLength(1);
 const scan:any=await client.callTool({name:'audio_scan',arguments:{asset_id:a.id}});expect(scan.isError).not.toBe(true);const scanned=JSON.parse(scan.content[0].text);expect(scanned.window).toEqual({start_seconds:0,end_seconds:1});expect(scanned.result.chunk_count).toBe(1);expect(scanned.result.chunks[0].segments).toHaveLength(1);
 } finally {await client.close();}
},15000);
import {withinDeadline} from '../src/media/deadline';
import {ReadBuffer} from '@modelcontextprotocol/sdk/shared/stdio.js';
test('one deadline cancels a subprocess after earlier stages spent time',async()=>{
 const start=Date.now();
 await expect(withinDeadline(async()=>{await new Promise(r=>setTimeout(r,50));await run(process.execPath,['-e','setTimeout(()=>{},10000)']);},90)).rejects.toThrow('timed out');
 expect(Date.now()-start).toBeLessThan(300);
});
test('provider buffer refuses oversized bytes before JSON parsing',()=>{
 const reader=new ReadBuffer({maxBufferSize:2*1024*1024});
 expect(()=>reader.append(Buffer.alloc(2*1024*1024+1))).toThrow('maximum size');
});
import {videoFrame} from '../src/media/video-vision';
test('video provider must be explicitly configured',async()=>{
 const saved=process.env.ISYMCP_VIDEO_VISION_ENTRY;delete process.env.ISYMCP_VIDEO_VISION_ENTRY;
 try {await expect(videoFrame('/unused.mp4',0)).rejects.toThrow('Configure ISYMCP_VIDEO_VISION_ENTRY');}
 finally {if(saved!==undefined)process.env.ISYMCP_VIDEO_VISION_ENTRY=saved;}
});
