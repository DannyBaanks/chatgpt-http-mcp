const VIDEO_ID = /^\d{19}$/;
const DIRECT_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const SHORT_HOSTS = new Set(['vt.tiktok.com', 'vm.tiktok.com']);

export type TikTokSource = { source_url:string; video_id?:string };
export type TikTokDownloadReceipt = { platform:'tiktok'; video_id:string; source_url:string; canonical_url:string };

function parsePublicHttps(input:string):URL {
 let url:URL;
 try { url=new URL(input); } catch { throw Error('Invalid TikTok URL'); }
 if(url.protocol!=='https:'||url.username||url.password||url.port) throw Error('Use a public HTTPS TikTok video URL');
 return url;
}

export function tiktokSource(input:string):TikTokSource {
 const url=parsePublicHttps(input),host=url.hostname.toLowerCase();
 if(DIRECT_HOSTS.has(host)) {
  const match=/^\/@([A-Za-z0-9._-]{1,24})\/video\/(\d{19})\/?$/.exec(url.pathname);
  if(match) return {source_url:`https://www.tiktok.com/@${match[1]}/video/${match[2]}`,video_id:match[2]};
 }
 if(SHORT_HOSTS.has(host)) {
  const match=/^\/([A-Za-z0-9_-]{5,32})\/?$/.exec(url.pathname);
  if(match) return {source_url:`https://${host}/${match[1]}/`};
 }
 throw Error('Only public TikTok video and vt/vm share links are supported');
}

export function verifyDownloadedTikTok(input:string,videoId:string,canonicalUrl:string):TikTokDownloadReceipt {
 const requested=tiktokSource(input),canonical=tiktokSource(canonicalUrl);
 if(!VIDEO_ID.test(videoId)||!canonical.video_id||canonical.video_id!==videoId||
    (requested.video_id!==undefined&&requested.video_id!==videoId)) {
  throw Error('Downloaded TikTok video identity did not match the canonical URL');
 }
 return {platform:'tiktok',video_id:videoId,source_url:requested.source_url,canonical_url:canonical.source_url};
}
