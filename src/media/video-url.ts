import { youtubeSource } from './youtube-url';
import { tiktokSource } from './tiktok-url';
export type MediaPlatform='youtube'|'tiktok';
export type MediaSource={platform:'youtube';source_url:string;video_id:string}|{platform:'tiktok';source_url:string;video_id?:string};

const YOUTUBE_HOSTS=new Set(['youtu.be','youtube.com','www.youtube.com','m.youtube.com','music.youtube.com']);

export function mediaSource(input:string):MediaSource {
 let host:string;
 try { host=new URL(input).hostname.toLowerCase(); } catch { throw Error('Invalid public video URL'); }
 if(YOUTUBE_HOSTS.has(host)) {
  const source_url=youtubeSource(input);
  return {platform:'youtube',source_url,video_id:new URL(source_url).searchParams.get('v')!};
 }
 return {platform:'tiktok',...tiktokSource(input)};
}
