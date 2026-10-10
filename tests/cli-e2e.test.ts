import {afterAll,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {chmodSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {run} from '../src/media/process';

const root=resolve(import.meta.dir,'..');
const homes:string[]=[];
function isolated(){
 const home=mkdtempSync(join(tmpdir(),'isymcp-cli-e2e-'));homes.push(home);
 const bridge=join(home,'.codex-web-http');mkdirSync(join(bridge,'bin'),{recursive:true});
 return {home,bridge,media:join(home,'media'),env:{...process.env,HOME:home,CODEX_WEB_HTTP_HOME:bridge,ISYMCP_MEDIA_HOME:join(home,'media'),CODEX_WEB_HTTP_PORT:String(42000+Math.floor(Math.random()*12000)),ISYMCP_PANEL_PORT:String(42000+Math.floor(Math.random()*12000))}};
}
function cli(args:string[],env:NodeJS.ProcessEnv,input?:string){
 return Bun.spawnSync([process.execPath,join(root,'src/isymcp.ts'),...args],{cwd:root,env,stdout:'pipe',stderr:'pipe',stdin:Buffer.from(input??''),timeout:30000});
}
function cliWithPrompts(args:string[],env:NodeJS.ProcessEnv,prompts:Array<{text:string;answer:string}>){
 const script=`import json,os,pty,select,signal,subprocess,sys,time,errno
command=[sys.argv[1],sys.argv[2],*json.loads(sys.argv[3])]
prompts=json.loads(sys.argv[4]);master,slave=pty.openpty()
p=subprocess.Popen(command,cwd=sys.argv[5],env=os.environ.copy(),stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave);out=b''
try:
 for item in prompts:
  target=item['text'].encode();deadline=time.time()+30
  while target not in out:
   remain=deadline-time.time()
   if remain<=0:raise TimeoutError('prompt missing: '+item['text'])
   ready,_,_=select.select([master],[],[],remain)
   if not ready:raise TimeoutError('prompt missing: '+item['text'])
   out+=os.read(master,65536)
  os.write(master,item['answer'].encode())
 p.wait(timeout=30)
 while True:
  try:
   ready,_,_=select.select([master],[],[],0.1)
   if not ready:break
   out+=os.read(master,65536)
  except OSError as error:
   if error.errno==errno.EIO:break
   raise
except Exception:
 try:os.killpg(p.pid,signal.SIGKILL)
 except ProcessLookupError:pass
 p.wait();print(out.decode(errors='replace'));raise
print(p.returncode);print(out.decode(errors='replace'))`;
 const result=Bun.spawnSync(['python3','-c',script,process.execPath,join(root,'src/isymcp.ts'),JSON.stringify(args),JSON.stringify(prompts),root],{cwd:root,env,stdout:'pipe',stderr:'pipe',timeout:65000});
 const lines=result.stdout.toString().split('\n'),exitCode=Number(lines.shift());
 return {exitCode,stdout:lines.join('\n')+result.stderr.toString(),stderr:result.stderr.toString()};
}
afterAll(()=>{for(const home of homes)rmSync(home,{recursive:true,force:true});});

test('CLI help, tree, and media CRUD execute in a private temporary HOME',()=>{
 const e=isolated();
 const help=cli(['--help'],e.env);expect(help.exitCode).toBe(0);expect(help.stdout.toString()).toContain('isymcp media prepare <url>');
 const tree=cli(['tree'],e.env);expect(tree.exitCode).toBe(0);expect(tree.stdout.toString()).toContain('Preparar video de YouTube');
 const list=cli(['media','list'],e.env);expect(list.exitCode).toBe(0);expect(JSON.parse(list.stdout.toString())).toEqual([]);
 const fixture=join(e.home,'fixture.wav');writeFileSync(fixture,'fixture-media');
 const added=cli(['media','add',fixture],e.env);expect(added.exitCode).toBe(0);const asset=JSON.parse(added.stdout.toString());expect(asset.sha256).toBeString();
 const listed=cli(['media','list'],e.env);expect(JSON.parse(listed.stdout.toString())).toHaveLength(1);
 const revoked=cli(['media','revoke',asset.id],e.env);expect(revoked.exitCode).toBe(0);
 expect(JSON.parse(cli(['media','list'],e.env).stdout.toString())).toEqual([]);
});

test('session, dry-run, log export, and read-only CLI commands stay inside temporary HOME',()=>{
 const e=isolated();
 const minted=cli(['session','mint','--cwd',e.home,'--label','e2e-readonly'],e.env);expect(minted.exitCode).toBe(0);expect(minted.stdout.toString()).toContain('writable: false');
 const fp=minted.stdout.toString().match(/fp:\s+([a-f0-9]{12})/)?.[1];expect(fp).toBeString();
 expect(cli(['session','list'],e.env).stdout.toString()).toContain(fp!);
 expect(cli(['session','revoke',fp!],e.env).exitCode).toBe(0);expect(cli(['session','list'],e.env).stdout.toString()).toContain('Sessions: 0');
 const model=cli(['models'],e.env);expect(model.exitCode).toBe(0);expect(model.stdout.toString()).toContain('dry-run');
 const tui=cli(['tui','list'],e.env);expect(tui.exitCode).toBe(0);
 const config=join(e.home,'opencode.json');const tuiDry=cli(['tui','install','--config',config],e.env);expect(tuiDry.exitCode).toBe(0);expect(tuiDry.stdout.toString()).toContain('dry-run');
 const harness=cli(['harness','install','codex','--json'],e.env);expect(harness.exitCode).toBe(0);
 const harnessRemove=cli(['harness','uninstall','codex','--json'],e.env);expect(harnessRemove.exitCode).toBe(0);
 const command=cli(['command','probe-cli'],e.env);expect(command.exitCode).toBe(0);expect(command.stdout.toString()).toContain('COMANDO: @CODEX ISYMCP');
 expect(cli(['canary','status'],e.env).exitCode).toBe(0);
 const canary=cli(['canary','schedule'],e.env);expect(canary.exitCode).toBe(0);expect(canary.stdout.toString()).toContain('no se toco nada');
 const unschedule=cli(['canary','unschedule'],e.env);expect(unschedule.exitCode).toBe(0);expect(unschedule.stdout.toString()).toContain('no se toco nada');
 const output=join(e.home,'logs-export.txt');const exported=cli(['logs','export','--out',output],e.env);expect(exported.exitCode).toBe(0);expect(exported.stdout.toString()).toContain(output);expect(readFileSync(output,'utf8')).toBe('');
 const filtered=join(e.home,'logs-filtered.txt');expect(cli(['logs','export','--since','2026-01-01T00:00:00Z','--until','2026-12-31T23:59:59Z','--out',filtered],e.env).exitCode).toBe(0);
 expect(cli(['logs','--last','20'],e.env).exitCode).toBe(0);
 const ask=cli(['ask'],e.env);expect(ask.exitCode).toBe(2);expect(ask.stderr.toString()).toContain('uso: isymcp ask');
 const invalidPrepare=cli(['media','prepare','https://example.com/video'],e.env);expect(invalidPrepare.exitCode).not.toBe(0);expect(JSON.parse(cli(['media','list'],e.env).stdout.toString())).toEqual([]);
 const cancelledPrepare=cli(['media','prepare'],e.env,'\n');expect(cancelledPrepare.exitCode).toBe(0);expect(JSON.parse(cli(['media','list'],e.env).stdout.toString())).toEqual([]);
 const launcher=cli(['codex','launcher'],e.env);expect(launcher.exitCode).toBe(0);expect(launcher.stdout.toString()).toContain('Lanzador instalado');
 const removed=cli(['codex','launcher','--remove'],e.env);expect(removed.exitCode).toBe(0);expect(removed.stdout.toString()).toContain('Lanzador removido');
},30000);

test('tunnel status and server lifecycle use only fake tools and isolated ports',async()=>{
 const e=isolated();const fakeTunnel=join(e.bridge,'bin','tunnel-client');
 writeFileSync(fakeTunnel,'#!/bin/sh\nprintf \'{"ready":true,"running":true,"runtime_state":"ready"}\\n\'\n');chmodSync(fakeTunnel,0o700);
 const tunnel=cli(['tunnel','status'],e.env);expect(tunnel.exitCode).toBe(0);expect(tunnel.stdout.toString()).toContain('ready=true');
 const status=cli(['status'],e.env);expect(status.exitCode).toBe(0);expect(status.stdout.toString()).toContain('tunel ready=true');
 const panelStatus=cli(['panel','status'],e.env);expect(panelStatus.exitCode).toBe(0);expect(panelStatus.stdout.toString()).toContain('panel down');
 const health=cli(['health'],e.env);expect(health.exitCode).toBe(1);expect(health.stderr.toString()).toContain('Bridge no disponible');
 const metrics=cli(['metrics'],e.env);expect(metrics.exitCode).toBe(1);expect(metrics.stderr.toString()).toContain('Error obteniendo métricas');
 const started=cli(['server','start','--no-connector'],e.env);expect(started.exitCode).toBe(0);expect(started.stdout.toString()).toContain('server detached');
 let healthy=false;for(let i=0;i<40;i++){try{healthy=(await fetch(`http://127.0.0.1:${e.env.CODEX_WEB_HTTP_PORT}/health`)).ok;}catch{}if(healthy)break;await new Promise(r=>setTimeout(r,100));}
 expect(healthy).toBe(true);
 const stopped=cli(['server','stop'],e.env);expect(stopped.exitCode).toBe(0);expect(stopped.stdout.toString()).toContain('server parado');
 const panel=cli(['panel','start'],e.env);expect(panel.exitCode).toBe(0);expect(panel.stdout.toString()).toContain('panel detached');
 const panelRoot=await fetch(`http://127.0.0.1:${e.env.ISYMCP_PANEL_PORT}/`);expect(panelRoot.ok).toBe(true);
 const panelStop=cli(['panel','stop'],e.env);expect(panelStop.exitCode).toBe(0);expect(panelStop.stdout.toString()).toContain('panel parado');
});

test('menu media-prepare routes into the shared guided flow and cancel never downloads',()=>{
 const e=isolated();
 const result=cli(['menu','media-prepare'],e.env,'\n');
 expect(result.exitCode).toBe(0);expect(result.stdout.toString()).toContain('Pega el enlace público de YouTube');
 expect(JSON.parse(cli(['media','list'],e.env).stdout.toString())).toEqual([]);
});

test('guided CLI prepares a generated video, verifies package hashes, then MCP recovers the same asset and saved artifacts',async()=>{
 const e=isolated(),bin=join(e.home,'bin'),fixture=join(e.home,'generated.mp4'),destination=join(e.home,'exports');mkdirSync(bin);mkdirSync(destination);
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=128x72:r=4:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-map','0:v','-map','1:a','-c:v','mpeg4','-c:a','aac','-shortest',fixture]);
 const fakeYtDlp=join(bin,'yt-dlp'),fakeZenity=join(bin,'zenity');
 writeFileSync(fakeYtDlp,`#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--dump-single-json')){console.log(JSON.stringify({id:'abcdefghijk',title:'CLI E2E Fixture',uploader:'ISyMCP Test',duration:2,width:128,height:72,filesize:999999}));process.exit(0)}const template=a[a.indexOf('-o')+1];const output=template.replace('%(ext)s','mp4');fs.copyFileSync(${JSON.stringify(fixture)},output);const receipt=a[a.indexOf('--print-to-file')+2];fs.writeFileSync(receipt,'abcdefghijk\\n');console.log(JSON.stringify(output));\n`);chmodSync(fakeYtDlp,0o700);
 writeFileSync(fakeZenity,'#!/bin/sh\nprintf \'%s\\n\' "$ISYMCP_E2E_PACKAGE_DIR"\n');chmodSync(fakeZenity,0o700);
 const env={...e.env,PATH:`${bin}:${process.env.PATH}`,ISYMCP_YTDLP_BIN:fakeYtDlp,ISYMCP_E2E_PACKAGE_DIR:destination};
 const url='https://youtu.be/abcdefghijk';
 const prepared=cliWithPrompts(['media','prepare'],env,[{text:'Pega el enlace público de YouTube',answer:`${url}\n`},{text:'¿Descargar y preparar este video?',answer:'s\n'}]);
 expect(prepared.exitCode).toBe(0);
 const summary=JSON.parse(prepared.stdout.toString().replaceAll('\r','').split('\n').filter(line=>line.startsWith('{')).at(-1)!);
 expect(summary.status).toBe('ready');expect(typeof summary.source_sha256).toBe('string');expect(typeof summary.manifest_sha256).toBe('string');
 const packagePath=summary.package_directory,manifestPath=join(packagePath,'manifest.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
 expect(createHash('sha256').update(readFileSync(manifestPath)).digest('hex')).toBe(summary.manifest_sha256);
 expect(manifest.source.sha256).toBe(summary.source_sha256);expect(manifest.source.video_id).toBe('abcdefghijk');expect(manifest.preparation.status).toBe('ready');
 for(const entry of manifest.files)expect(createHash('sha256').update(readFileSync(join(packagePath,entry.path))).digest('hex')).toBe(entry.sha256);
 expect(manifest.files.some((file:any)=>file.kind==='audio_scan')).toBe(true);expect(manifest.files.some((file:any)=>file.kind==='contact_sheet')).toBe(true);
 const catalog=JSON.parse(cli(['media','list'],env).stdout.toString());expect(catalog).toContainEqual(expect.objectContaining({id:summary.asset_id,source_url:'https://www.youtube.com/watch?v=abcdefghijk',sha256:summary.source_sha256}));
 const legacy=cli(['media','prepare',url],env);expect(legacy.exitCode).toBe(0);const legacySummary=JSON.parse(legacy.stdout.toString());expect(legacySummary).toMatchObject({asset_id:summary.asset_id,status:'ready'});expect(Object.keys(legacySummary)).toEqual(['asset_id','status','duration_seconds','sheet_count','segment_count']);

 const client=new Client({name:'cli-media-e2e',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[join(root,'src/mcp/media.ts')],env:{...env,ISYMCP_MEDIA_HOME:e.media} as Record<string,string>});
 try {
  await client.connect(transport);const tools=(await client.listTools()).tools;expect(tools.map(tool=>tool.name)).toContain('media_lookup');
  const lookup:any=await client.callTool({name:'media_lookup',arguments:{url:'https://www.youtube.com/watch?v=abcdefghijk'}});
  expect(lookup.isError).not.toBe(true);const payload=JSON.parse(lookup.content[0].text);expect(payload).toMatchObject({found:true,status:'ready',asset_id:summary.asset_id,source_sha256:summary.source_sha256});expect(payload.audio_scan.window).toMatchObject({start_seconds:0,end_seconds:2});expect(payload.sheets).toHaveLength(1);
  const sheet:any=await client.callTool({name:'media_lookup',arguments:{url:'https://www.youtube.com/watch?v=abcdefghijk',sheet_index:0}});
  expect(sheet.isError).not.toBe(true);expect(JSON.parse(sheet.content[0].text).selected_sheet.index).toBe(0);expect(sheet.content.filter((part:any)=>part.type==='image')).toHaveLength(1);
  const schema=tools.find(tool=>tool.name==='media_lookup')!.inputSchema as any;expect(Object.keys(schema.properties??{})).not.toContain('path');
 } finally {await client.close();}
});
