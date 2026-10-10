import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { MediaCatalog, MediaDownloadReceipt } from './catalog';
import { withinDeadline, remaining } from './deadline';
import { probe } from './audio';
import { downloadYouTube, YouTubeDownloadResult, verifyDownloadedYouTubeId } from './youtube';
import { youtubeSource } from './youtube-url';
export { youtubeSource } from './youtube-url';
export type ImportJob={job_id:string,state:'running'|'complete'|'failed',source_url:string,phase:string,asset?:{id:string,name:string,bytes:number,sha256:string},error?:string};
export type Downloader=(url:string,dir:string,maxBytes:number)=>Promise<string|YouTubeDownloadResult>;
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
    const downloaded=await this.downloader(source_url,dir,this.limits.maxBytes);
    let file:string,receipt:MediaDownloadReceipt|undefined;
    if(typeof downloaded==='string')file=downloaded;
    else {
     const verified=verifyDownloadedYouTubeId(source_url,downloaded.video_id);
     if(downloaded.source_url!==verified.source_url)throw Error('Downloaded YouTube video identity did not match the canonical URL');
     file=downloaded.path;receipt=verified;
    }
    remaining();if(dirname(realpathSync(file))!==realpathSync(dir))throw Error('Downloader returned an unauthorized path');
    const stat=statSync(file);if(!stat.isFile()||stat.size>this.limits.maxBytes)throw Error('Downloaded media exceeds file limit');
    view.phase='validating';save();const info=await probe(file);
    if(info.duration_seconds>1800||!info.streams.some(s=>['audio','video'].includes(String(s.codec_type))))throw Error('Import requires playable audio/video of at most 30 minutes');
    remaining();const a=await this.catalog.add(file,source_url,receipt);
    view.asset={id:a.id,name:a.name,bytes:a.bytes,sha256:a.sha256};view.state='complete';view.phase='ready';try{save();}catch{/* committed asset remains available if journaling fails */}
   } finally {this.active=false;}
  },this.limits.timeoutMs??180000).catch(error=>{
   view.state='failed';view.phase='failed';
   // Do not forward provider stderr: it can include signed URLs and local paths.
   const message=error instanceof Error?error.message:'';
   view.error=message.includes('identity')?'Downloaded video identity did not match the requested URL':message.includes('timed out')?'Import timed out; try a shorter video':message.includes('limit')?'Import exceeded the local size limit':'Download or media validation failed; source may be unavailable, require login, or be blocked';
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
