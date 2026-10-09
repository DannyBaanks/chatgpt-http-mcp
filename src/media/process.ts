import { remaining, signal } from './deadline';
import { spawn } from 'node:child_process';
export function run(command:string, args:string[], maxBytes=1024*1024, timeout=60000):Promise<Buffer> {
 return new Promise((resolve,reject)=>{
  timeout=Math.min(timeout,remaining());
  const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
  let size=0, error='', failure:Error|undefined; const chunks:Buffer[]=[];
  const fail=(message:string)=>{ failure ||= Error(message); child.kill('SIGKILL'); };
  const timer=setTimeout(()=>fail('Media process timed out'),timeout);
  const abort=()=>fail('Media query timed out'); const cancellation=signal(); cancellation?.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length; if(size>maxBytes) fail('Media output exceeds limit'); else chunks.push(chunk);});
  child.stderr.on('data',(chunk:Buffer)=>{ if(error.length<4096) error+=chunk.toString().slice(0,4096-error.length); });
  child.on('error',e=>{clearTimeout(timer); cancellation?.removeEventListener('abort',abort);reject(e);});
  child.on('close',code=>{clearTimeout(timer); cancellation?.removeEventListener('abort',abort); if(failure) reject(failure); else if(code!==0) reject(Error(`Media process failed (${code}): ${error}`)); else resolve(Buffer.concat(chunks));});
 });
}
