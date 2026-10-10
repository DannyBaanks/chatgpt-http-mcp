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

export function verifyDownloadedYouTubeId(input:string,downloadedId:string):{video_id:string;source_url:string} {
 const source_url=youtubeSource(input);
 const expectedId=new URL(source_url).searchParams.get('v');
 if(!/^[-_A-Za-z0-9]{11}$/.test(downloadedId)||downloadedId!==expectedId) {
  throw Error('Downloaded YouTube video identity did not match the canonical URL');
 }
 return {video_id:downloadedId,source_url};
}
