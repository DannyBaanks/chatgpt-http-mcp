import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { run } from './process';
import { verifyDownloadedYouTubeId } from './youtube-url';
import { tiktokSource, verifyDownloadedTikTok, TikTokDownloadReceipt } from './tiktok-url';
import { isBotWallFailure } from './ytdlp-signatures';
export { verifyDownloadedYouTubeId } from './youtube-url';
export type YouTubeDownloadResult = { path:string; video_id:string; source_url:string };
export type TikTokDownloadResult = TikTokDownloadReceipt & { path:string };
export function youtubeDownloaderBinary(env:NodeJS.ProcessEnv=process.env):string {
 const command=process.platform==='win32'?'yt-dlp.exe':'yt-dlp';
 const installed=join(homedir(),'.oamaestro','bin',command);
 return env.ISYMCP_YTDLP_BIN || (existsSync(installed)?installed:command);
}
export function downloadBudget(dir:string,maxBytes:number):string|undefined {
 let sum=0;
 for(const name of readdirSync(dir)){const stat=statSync(join(dir,name));if(!stat.isFile())continue;sum+=stat.size;if(stat.
   size>maxBytes)return 'Downloaded media exceeds file limit';}
 if(sum>maxBytes*2)return 'Download workspace exceeds disk limit';
 const disk=statfsSync(dir);if(disk.bavail*disk.bsize<64*1024*1024)return 'Insufficient free disk space for import';
}
async function extractWithYtDlp(url:string,dir:string,maxBytes:number,runner:typeof run,
 includeWebpageUrl:boolean):Promise<{path:string;video_id:string;webpage_url?:string}> {
 const command=youtubeDownloaderBinary();
 const node=process.env.ISYMCP_VIDEO_VISION_NODE||'node';
 const idPath=join(dir,'downloaded-video-id.txt');
 const webpageUrlPath=join(dir,'downloaded-webpage-url.txt');
 // Vertical TikToks report their portrait resolution in `width` (for example
 // 720x1280), while the YouTube selector has historically capped `height`.
 const formatSelector=includeWebpageUrl?'best[height<=720]/best[width<=720]':'best[height<=720]/bestvideo[height<=720]+bestaudio';
 const args=[
  '--ignore-config','--no-plugin-dirs','--no-cache-dir','--no-playlist','--no-progress','--no-warnings',
  '--socket-timeout','10','--retries','1','--fragment-retries','1','--concurrent-fragments','1',
  '--match-filters','!is_live & duration <= 1800','--max-filesize',String(maxBytes),
  '--js-runtimes',`node:${node}`,
  '-f',formatSelector,'--merge-output-format','mp4',
  '--print-to-file','after_move:%(id)s',idPath,
 ];
 if(includeWebpageUrl) args.push('--print-to-file','after_move:%(webpage_url)s',webpageUrlPath);
 args.push('-o',join(dir,'media.%(ext)s'),'--print','after_move:%(filepath)j');
 const options={env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:dir,TMPDIR:dir,LANG:'C.UTF-8'},
  guard:()=>downloadBudget(dir,maxBytes),processGroup:true};
 let output:Buffer;
 try {output=await runner(command,[...args,url],8192,180000,options);}
 catch(error) {
  // Some videos are gated behind YouTube's "confirm you're not a bot" check for the default clients;
  // the embedded web player client still serves them without cookies, config or plugins. That player
  // is a YouTube extractor, so a TikTok failure re-raises the original error rather than retrying.
  if(includeWebpageUrl||!isBotWallFailure(error))throw error;
  try {output=await runner(command,[...args,'--extractor-args','youtube:player_client=web_embedded',url],8192,180000,options);}
  catch{throw error;}
 }
 const lines=output.toString().trim().split('\n');
 if(lines.length!==1)throw Error('Downloader did not return one media file');
 const path=JSON.parse(lines[0]);if(typeof path!=='string'||!isAbsolute(path))throw Error('Invalid download output');
 const video_id=readFileSync(idPath,'utf8').trim();
 const violation=downloadBudget(dir,maxBytes);if(violation)throw Error(violation);
 return {path,video_id,webpage_url:includeWebpageUrl?readFileSync(webpageUrlPath,'utf8').trim():undefined};
}

export async function downloadYouTube(url:string,dir:string,maxBytes:number,runner:typeof run=run):Promise<YouTubeDownloadResult> {
 const extracted=await extractWithYtDlp(url,dir,maxBytes,runner,false);
 return {path:extracted.path,...verifyDownloadedYouTubeId(url,extracted.video_id)};
}

export async function downloadTikTok(url:string,dir:string,maxBytes:number,runner:typeof run=run):Promise<TikTokDownloadResult> {
 const source=tiktokSource(url);
 const extracted=await extractWithYtDlp(source.source_url,dir,maxBytes,runner,true);
 const receipt=verifyDownloadedTikTok(source.source_url,extracted.video_id,extracted.webpage_url??'');
 return {path:extracted.path,...receipt};
}
