import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MediaCatalog} from '../src/media/catalog';
import {MediaImporter, youtubeSource} from '../src/media/importer';
import {run} from '../src/media/process';
test('YouTube import canonicalizes one video and rejects arbitrary destinations',()=>{
 expect(youtubeSource('https://www.youtube.com/shorts/lHkDE3BahB0?utm_source=chatgpt.com')).toBe('https://www.youtube.com/watch?v=lHkDE3BahB0');
 expect(youtubeSource('https://youtu.be/lHkDE3BahB0')).toBe('https://www.youtube.com/watch?v=lHkDE3BahB0');
 for(const url of ['http://youtube.com/watch?v=lHkDE3BahB0','https://127.0.0.1/a','file:///etc/passwd','https://youtube.com.evil.example/watch?v=lHkDE3BahB0','https://youtube.com/playlist?list=x','https://user:pass@youtube.com/watch?v=lHkDE3BahB0'])expect(()=>youtubeSource(url)).toThrow();
});
test('import job returns immediately, serializes downloads and registers an actual media file',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-import-'));const catalog=new MediaCatalog(join(root,'state'));
 const importer=new MediaImporter(catalog,async(_url,dir)=>{await new Promise(r=>setTimeout(r,30));const path=join(dir,'media.wav');await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1',path]);return path;});
 const job=importer.start('https://youtu.be/lHkDE3BahB0');expect(job.state).toBe('running');
 expect(()=>importer.start('https://youtu.be/lHkDE3BahB0')).toThrow('busy');
 const done=await importer.status(job.job_id,10);expect(done.state).toBe('complete');expect(done.asset?.id).toContain('media_');
 expect(catalog.list()[0].source_url).toBe('https://www.youtube.com/watch?v=lHkDE3BahB0');
 expect(JSON.stringify(done)).not.toContain(root);
});
test('failed, oversized and non-media downloads never register an asset',async()=>{
 for(const mode of ['error','oversize','invalid']) {
  const root=mkdtempSync(join(tmpdir(),'isymcp-import-fail-'));const c=new MediaCatalog(join(root,'state'));
  const importer=new MediaImporter(c,async(_url,dir)=>{if(mode==='error')throw Error('HTTP 403');const path=join(dir,'media.mp4');writeFileSync(path,Buffer.alloc(mode==='oversize'?101:1));return path;},{maxBytes:100});
  const job=importer.start('https://youtu.be/lHkDE3BahB0');const done=await importer.status(job.job_id,10);expect(done.state).toBe('failed');expect(c.list()).toHaveLength(0);
 }
});
import {downloadBudget} from '../src/media/youtube';
test('disk guard detects excessive bytes and stops a running downloader',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-budget-'));writeFileSync(join(root,'media.part'),Buffer.alloc(101));
 expect(downloadBudget(root,100)).toContain('limit');
 await expect(run(process.execPath,['-e','setTimeout(()=>{},10000)'],1024,10000,{guard:()=>downloadBudget(root,100),processGroup:true})).rejects.toThrow('limit');
});
test('import timeout becomes a failed job and does not register a partial file',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-import-timeout-'));const c=new MediaCatalog(join(root,'state'));
 const importer=new MediaImporter(c,async()=>{await run(process.execPath,['-e','setTimeout(()=>{},10000)']);return '';},{maxBytes:100,timeoutMs:30});
 const j=importer.start('https://youtu.be/lHkDE3BahB0');const done=await importer.status(j.job_id,1);
 expect(done.state).toBe('failed');expect(done.error).toContain('timed out');expect(c.list()).toHaveLength(0);
});
import {spawn} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
test('stopping the MCP parent terminates its grouped download process',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-stop-'));const pidFile=join(root,'pid');
 const childCode=`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
 const parentCode=`import {run} from ${JSON.stringify(join(import.meta.dir,'../src/media/process.ts'))};await run(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(childCode)}],1024,10000,{processGroup:true});`;
 const parent=spawn(process.execPath,['-e',parentCode],{stdio:'ignore'});let pid:number|undefined;
 try {
  for(let i=0;i<100&&!existsSync(pidFile);i++)await new Promise(r=>setTimeout(r,10));
  expect(existsSync(pidFile)).toBe(true);pid=Number(readFileSync(pidFile,'utf8'));parent.kill('SIGTERM');
  await new Promise<void>(r=>parent.once('close',()=>r()));await new Promise(r=>setTimeout(r,100));
  const state=existsSync(`/proc/${pid}/stat`)?readFileSync(`/proc/${pid}/stat`,'utf8').split(' ')[2]:'gone';
  expect(['gone','Z']).toContain(state);
 }finally{parent.kill('SIGKILL');if(pid)try{process.kill(pid,'SIGKILL');}catch{}}
},5000);
