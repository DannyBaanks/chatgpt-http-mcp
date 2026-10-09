import { remaining } from './deadline';
import { mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { open, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, extname } from 'node:path';
export type Asset = { id:string; path:string; realPath:string; sha256:string; bytes:number; name:string; revoked:boolean; addedAt:string; sourceUrl?:string };
const extensions = new Set(['.wav','.flac','.mp3','.m4a','.mp4','.mov','.webm']);
export const digest = (b:Buffer) => createHash('sha256').update(b).digest('hex');
export async function boundedRead(path:string):Promise<Buffer> {
 const handle=await open(path,'r');
 try {
  const info=await handle.stat();
  if(!info.isFile() || info.size>500*1024*1024) throw Error('Media must be a file of at most 500 MiB');
  const chunks:Buffer[]=[]; let total=0;
  for (;;) { remaining(); const chunk=Buffer.alloc(1024*1024); const {bytesRead}=await handle.read(chunk,0,chunk.length,null); if(!bytesRead) break;
   total+=bytesRead; if(total>500*1024*1024) throw Error('Media exceeds limit'); chunks.push(chunk.subarray(0,bytesRead)); }
  return Buffer.concat(chunks,total);
 } finally {await handle.close();}
}
export class MediaCatalog {
 constructor(public home=process.env.ISYMCP_MEDIA_HOME || join(homedir(),'.local/state/isymcp/media')) { mkdirSync(home,{recursive:true,mode:0o700}); }
 private file(id:string) { if(!/^media_[a-f0-9-]{36}$/.test(id)) throw Error('Invalid asset ID'); return join(this.home,id+'.json'); }
 private save(a:Asset) { const file=this.file(a.id); const temp=file+'.'+randomUUID()+'.tmp'; writeFileSync(temp,JSON.stringify(a),{mode:0o600,flag:'wx'}); renameSync(temp,file); }
 get(id:string):Asset { const a=JSON.parse(readFileSync(this.file(id),'utf8')) as Asset; if(a.revoked) throw Error('Asset revoked'); return a; }
 async add(input:string,sourceUrl?:string):Promise<Asset> {
  const path=resolve(input), realPath=realpathSync(path); if(!extensions.has(extname(path).toLowerCase())) throw Error('Unsupported media extension');
  const s=statSync(realPath); if(!s.isFile() || s.size>500*1024*1024) throw Error('Media must be a file of at most 500 MiB');
  const bytes=await boundedRead(realPath); if(bytes.length>500*1024*1024 || realpathSync(path)!==realPath) throw Error('Asset changed during registration');
  const a:Asset={id:'media_'+randomUUID(),path,realPath,sha256:digest(bytes),bytes:bytes.length,name:path.split('/').pop()!,revoked:false,addedAt:new Date().toISOString(),sourceUrl}; remaining(); this.save(a); return a;
 }
 async resolve(id:string):Promise<Asset> {
  const a=this.get(id); if(realpathSync(a.path)!==a.realPath) throw Error('Asset changed: register again');
  const s=statSync(a.realPath); if(!s.isFile() || s.size!==a.bytes) throw Error('Asset changed: register again');
  const data=await boundedRead(a.realPath); if(digest(data)!==a.sha256) throw Error('Asset changed: register again'); this.get(id); return a;
 }
 findBySourceUrl(canonicalUrl:string):Asset|undefined {
  const match=this.list().find(asset=>asset.source_url===canonicalUrl);
  return match?this.get(match.id):undefined;
 }
 async snapshot<T>(id:string, work:(asset:Asset,path:string)=>Promise<T>):Promise<T> {
  const a=this.get(id);
  if(realpathSync(a.path)!==a.realPath) throw Error('Asset changed: register again');
  const data=await boundedRead(a.realPath);
  if(data.length!==a.bytes || digest(data)!==a.sha256 || realpathSync(a.path)!==a.realPath) throw Error('Asset changed: register again');
  this.get(id);
  const dir=await mkdtemp(join(this.home,'job-')); const file=join(dir,'input'+extname(a.path));
  try {await writeFile(file,data,{mode:0o600,flag:'wx'}); const result=await work(a,file); remaining(); this.get(id); return result;}
  finally {await unlink(file).catch(()=>{}); await rmdir(dir).catch(()=>{});}
 }
 list() { return readdirSync(this.home).filter(f=>/^media_[a-f0-9-]{36}\.json$/.test(f)).map(f=>JSON.parse(readFileSync(join(this.home,f),'utf8')) as Asset).filter(a=>!a.revoked).map(({id,name,bytes,sha256,sourceUrl})=>({id,name,bytes,sha256,source_url:sourceUrl})); }
 revoke(id:string) { const a=JSON.parse(readFileSync(this.file(id),'utf8')) as Asset; this.save({...a,revoked:true}); }
}
