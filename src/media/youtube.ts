import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { run } from './process';
export function downloadBudget(dir:string,maxBytes:number):string|undefined {
 let sum=0;
 for(const name of readdirSync(dir)){const stat=statSync(join(dir,name));if(!stat.isFile())continue;sum+=stat.size;if(stat.size>maxBytes)return 'Downloaded media exceeds file limit';}
 if(sum>maxBytes*2)return 'Download workspace exceeds disk limit';
 const disk=statfsSync(dir);if(disk.bavail*disk.bsize<64*1024*1024)return 'Insufficient free disk space for import';
}
export async function downloadYouTube(url:string,dir:string,maxBytes:number):Promise<string> {
 const installed=join(homedir(),'.oamaestro/bin/yt-dlp');
 const command=process.env.ISYMCP_YTDLP_BIN || (existsSync(installed)?installed:'yt-dlp');
 const node=process.env.ISYMCP_VIDEO_VISION_NODE||'node';
 const output=await run(command,[
  '--ignore-config','--no-plugin-dirs','--no-cache-dir','--no-playlist','--no-progress','--no-warnings',
  '--socket-timeout','10','--retries','1','--fragment-retries','1','--concurrent-fragments','1',
  '--match-filters','!is_live & duration <= 1800','--max-filesize',String(maxBytes),
  '--js-runtimes',`node:${node}`,
  '-f','best[height<=720]/bestvideo[height<=720]+bestaudio','--merge-output-format','mp4',
  '-o',join(dir,'media.%(ext)s'),'--print','after_move:%(filepath)j',url,
 ],8192,180000,{env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:dir,TMPDIR:dir,LANG:'C.UTF-8'},guard:()=>downloadBudget(dir,maxBytes),processGroup:true});
 const lines=output.toString().trim().split('\n');
 if(lines.length!==1)throw Error('Downloader did not return one media file');
 const path=JSON.parse(lines[0]);if(typeof path!=='string'||!isAbsolute(path))throw Error('Invalid download output');
 const violation=downloadBudget(dir,maxBytes);if(violation)throw Error(violation);
 return path;
}
