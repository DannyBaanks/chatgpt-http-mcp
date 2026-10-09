import { remaining, signal } from './deadline';
import { spawn } from 'node:child_process';
const downloadGroups=new Set<number>();let shutdownInstalled=false;
function stopDownloadGroups(){for(const pid of downloadGroups){try{process.kill(-pid,'SIGKILL');}catch{}}}
function trackDownloadGroup(pid:number){
 downloadGroups.add(pid);
 if(shutdownInstalled)return;shutdownInstalled=true;
 process.on('exit',stopDownloadGroups);
 process.once('SIGTERM',()=>{stopDownloadGroups();process.exit(143);});
 process.once('SIGINT',()=>{stopDownloadGroups();process.exit(130);});
}

export function run(command:string, args:string[], maxBytes=1024*1024, timeout=60000,options:{env?:NodeJS.ProcessEnv,guard?:()=>string|undefined,processGroup?:boolean,input?:Buffer}={}):Promise<Buffer> {
 return new Promise((resolve,reject)=>{
  timeout=Math.min(timeout,remaining());
  const child=spawn(command,args,{stdio:[options.input?'pipe':'ignore','pipe','pipe'],env:options.env,detached:options.processGroup&&process.platform!=='win32'});
  if(options.processGroup&&child.pid&&process.platform!=='win32')trackDownloadGroup(child.pid);
  let size=0, error='', failure:Error|undefined; const chunks:Buffer[]=[];
  const fail=(message:string)=>{ failure ||= Error(message); if(options.processGroup&&child.pid&&process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}else child.kill('SIGKILL'); };
  const guard=options.guard?setInterval(()=>{try{const message=options.guard!();if(message)fail(message);}catch{fail('Download monitoring failed');}},100):undefined;
  const timer=setTimeout(()=>fail('Media process timed out'),timeout);
  const abort=()=>fail('Media query timed out'); const cancellation=signal(); cancellation?.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length; if(size>maxBytes) fail('Media output exceeds limit'); else chunks.push(chunk);});
  child.stderr.on('data',(chunk:Buffer)=>{ if(error.length<4096) error+=chunk.toString().slice(0,4096-error.length); });
  if(options.input){child.stdin?.on('error',()=>{});child.stdin?.end(options.input);}
  child.on('error',e=>{clearTimeout(timer);if(guard)clearInterval(guard); cancellation?.removeEventListener('abort',abort);reject(e);});
  child.on('close',code=>{if(child.pid)downloadGroups.delete(child.pid);clearTimeout(timer);if(guard)clearInterval(guard); cancellation?.removeEventListener('abort',abort); if(failure) reject(failure); else if(code!==0) reject(Error(`Media process failed (${code}): ${error}`)); else resolve(Buffer.concat(chunks));});
 });
}
