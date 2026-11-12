import { existsSync, readFileSync, readdirSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { run } from './process';
import { verifyDownloadedYouTubeId } from './youtube-url';
import { tiktokSource, verifyDownloadedTikTok, TikTokDownloadReceipt } from './tiktok-url';
import { isBotWallFailure } from './ytdlp-signatures';
export { verifyDownloadedYouTubeId } from './youtube-url';
export type YouTubeDownloadResult = { path:string; video_id:string; source_url:string };
export type TikTokDownloadResult = TikTokDownloadReceipt & { path:string };
export type GenericDownloadResult = { platform: 'instagram' | 'twitter' | 'direct' | 'generic'; path: string; video_id: string; source_url: string; canonical_url: string };
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
/**
 * ¿El yt-dlp instalado puede suplantar a Chrome? Necesita curl_cffi (el build standalone lo trae; el
 * zipapp de Python no). TikTok bloquea las peticiones sin suplantación ("Unexpected response from webpage
 * request", medido 2026-11-12). Se pregunta UNA vez por binario y se recuerda.
 */
const impersonateSupport=new Map<string,Promise<boolean>>();
export function canImpersonateChrome(command:string,runner:typeof run=run):Promise<boolean> {
 if(!impersonateSupport.has(command)) {
  impersonateSupport.set(command,runner(command,['--ignore-config','--list-impersonate-targets'],65536,30000,
   {env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C.UTF-8'}})
   .then((out)=>out.toString().split('\n').some((l)=>/^\s*chrome\b/i.test(l)&&!/unavailable/i.test(l)))
   .catch(()=>false));
 }
 return impersonateSupport.get(command)!;
}
/** Solo para pruebas: olvida lo que se sabía de cada binario. */
export function resetImpersonateCache():void { impersonateSupport.clear(); }

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
  // Solo fuera de YouTube (TikTok, Instagram, X, genéricos) y solo si este yt-dlp puede: YouTube no cambia.
  ...(includeWebpageUrl&&await canImpersonateChrome(command,runner)?['--impersonate','chrome']:[]),
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

export async function downloadDirectMedia(url:string,dir:string,maxBytes:number,runner:typeof run=run):Promise<GenericDownloadResult> {
 const parsed=new URL(url);
 const ext=extname(parsed.pathname).toLowerCase()||'.mp4';
 const outPath=join(dir,`media${ext}`);
 const id=createHash('sha256').update(url).digest('hex').slice(0,16);

 try {
  const res=await fetch(url);
  if(!res.ok) throw Error(`HTTP download failed: ${res.status}`);
  const contentLength=Number(res.headers.get('content-length')||0);
  if(contentLength>maxBytes) throw Error('Downloaded media exceeds file limit');
  const arrayBuffer=await res.arrayBuffer();
  const buf=Buffer.from(arrayBuffer);
  if(buf.length>maxBytes) throw Error('Downloaded media exceeds file limit');
  writeFileSync(outPath,buf);
 } catch(err:any) {
  if(err.message?.includes('exceeds file limit')) throw err;
  const extracted=await extractWithYtDlp(url,dir,maxBytes,runner,false);
  return {platform:'direct',path:extracted.path,video_id:extracted.video_id||id,source_url:url,canonical_url:url};
 }
 const violation=downloadBudget(dir,maxBytes);
 if(violation) throw Error(violation);
 return {platform:'direct',path:outPath,video_id:id,source_url:url,canonical_url:url};
}

export async function downloadSocialMedia(
 url:string,
 dir:string,
 maxBytes:number,
 platform:'instagram'|'twitter'|'generic',
 runner:typeof run=run,
):Promise<GenericDownloadResult> {
 const extracted=await extractWithYtDlp(url,dir,maxBytes,runner,true);
 const id=extracted.video_id||createHash('sha256').update(url).digest('hex').slice(0,16);
 return {platform,path:extracted.path,video_id:id,source_url:url,canonical_url:extracted.webpage_url??url};
}
