import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { MediaCatalog } from './catalog';
import { withinDeadline, remaining } from './deadline';
import { probe } from './audio';
import { downloadYouTube } from './youtube';
export function youtubeSource(input:string):string {
 let url:URL;try{url=new URL(input);}catch{throw Error('Invalid YouTube URL');}
 if(url.protocol!=='https:'||url.username||url.password||url.port) throw Error('Use a public HTTPS YouTube video URL');
 const host=url.hostname.toLowerCase();let id:string|undefined;
 if(host==='youtu.be')id=url.pathname.slice(1);
 else if(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(host)) {
  if(url.pathname==='/watch')id=url.searchParams.get('v')||undefined;
  else id=/^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
 }
 if(!id||!/^[-_A-Za-z0-9]{11}$/.test(id))throw Error('Only individual YouTube videos and Shorts are supported');
 return `https://www.youtube.com/watch?v=${id}`;
}
export type ImportJob={job_id:string,state:'running'|'complete'|'failed',source_url:string,phase:string,asset?:{id:string,name:string,bytes:number,sha256:string},error?:string};
export type Downloader=(url:string,dir:string,maxBytes:number)=>Promise<string>;
export class MediaImporter {
 private jobs=new Map<string,{view:ImportJob,done:Promise<void>}>();
 active=false;
 constructor(private catalog:MediaCatalog,private downloader:Downloader=downloadYouTube,private limits:{maxBytes:number,timeoutMs?:number}={maxBytes:500*1024*1024,timeoutMs:180000}){}
 start(input:string):ImportJob {
  const source_url=youtubeSource(input);if(this.active)throw Error('Media worker busy; retry after current query finishes');
  if(this.jobs.size>=50) {const oldest=[...this.jobs].find(([,j])=>j.view.state!=='running');if(oldest)this.jobs.delete(oldest[0]);}
  const job_id='import_'+randomUUID();const view:ImportJob={job_id,state:'running',source_url,phase:'downloading'};
  const downloads=join(this.catalog.home,'downloads');mkdirSync(downloads,{recursive:true,mode:0o700});
  const dir=mkdtempSync(join(downloads,'import-'));
  const save=()=>writeFileSync(join(dir,'job.json'),JSON.stringify(view,null,2),{mode:0o600});save();this.active=true;
  const done=withinDeadline(async()=>{
   try {
    const file=await this.downloader(source_url,dir,this.limits.maxBytes);
    remaining();if(dirname(realpathSync(file))!==realpathSync(dir))throw Error('Downloader returned an unauthorized path');
    const stat=statSync(file);if(!stat.isFile()||stat.size>this.limits.maxBytes)throw Error('Downloaded media exceeds file limit');
    view.phase='validating';save();const info=await probe(file);
    if(info.duration_seconds>1800||!info.streams.some(s=>['audio','video'].includes(String(s.codec_type))))throw Error('Import requires playable audio/video of at most 30 minutes');
    remaining();const a=await this.catalog.add(file,source_url);
    view.asset={id:a.id,name:a.name,bytes:a.bytes,sha256:a.sha256};view.state='complete';view.phase='ready';try{save();}catch{/* committed asset remains available if journaling fails */}
   } finally {this.active=false;}
  },this.limits.timeoutMs??180000).catch(error=>{
   view.state='failed';view.phase='failed';
   // Do not forward provider stderr: it can include signed URLs and local paths.
   const message=error instanceof Error?error.message:'';
   view.error=message.includes('timed out')?'Import timed out; try a shorter video':message.includes('limit')?'Import exceeded the local size limit':'Download or media validation failed; source may be unavailable, require login, or be blocked';
   try{save();}catch{/* state remains available in memory if disk is full */}
  });
  this.jobs.set(job_id,{view,done});return {...view};
 }
 async status(id:string,wait_seconds=0):Promise<ImportJob> {
  if(!/^import_[a-f0-9-]{36}$/.test(id)||!this.jobs.has(id))throw Error('Unknown import job; jobs reset on server restart. Check media_list for completed imports');
  if(!Number.isInteger(wait_seconds)||wait_seconds<0||wait_seconds>10)throw Error('wait_seconds must be between 0 and 10');
  const job=this.jobs.get(id)!;
  if(job.view.state==='running'&&wait_seconds) {
   let timer:ReturnType<typeof setTimeout>;
   try{await Promise.race([job.done,new Promise<void>(resolve=>{timer=setTimeout(resolve,wait_seconds*1000);})]);}finally{clearTimeout(timer!);}
  }
  return {...job.view};
 }
}
