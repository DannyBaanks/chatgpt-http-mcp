import {test,expect} from 'bun:test';
import * as downloader from '../src/media/youtube';
import * as importerApi from '../src/media/importer';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {run} from '../src/media/process';

const share='https://vt.tiktok.com/ZSgLUAEhe/?_r=1&_t=ZS-9AaiSktAvWC';
const canonical='https://www.tiktok.com/@theunearthlyhub/video/7695118893425102113';
const videoId='7695118893425102113';

test('TikTok canonicalization accepts direct videos and short links while dropping tracking parameters',()=>{
 const normalize=(importerApi as any).mediaSource;
 expect(typeof normalize).toBe('function');
 expect(normalize(share)).toEqual({platform:'tiktok',source_url:'https://vt.tiktok.com/ZSgLUAEhe/'});
 expect(normalize('https://vm.tiktok.com/ZM1234567/')).toEqual({platform:'tiktok',source_url:'https://vm.tiktok.com/ZM1234567/'});
 expect(normalize('https://www.tiktok.com/@theunearthlyhub/video/7695118893425102113?_r=1&_t=ZS-9AaiSktAvWC'))
  .toEqual({platform:'tiktok',source_url:canonical,video_id:videoId});
});

test('TikTok canonicalization rejects lookalike hosts, private URL syntax and non-video paths',()=>{
 const normalize=(importerApi as any).mediaSource;
 expect(typeof normalize).toBe('function');
 for(const url of [
  'https://tiktok.com.evil.example/@user/video/7695118893425102113',
  'http://www.tiktok.com/@user/video/7695118893425102113',
  'https://user:pass@www.tiktok.com/@user/video/7695118893425102113',
  'https://www.tiktok.com/@user/photo/7695118893425102113',
  'https://vt.tiktok.com/',
 ]) expect(()=>normalize(url)).toThrow();
});

test('TikTok download receipt matches both the requested direct ID and yt-dlp final page',()=>{
 const verify=(importerApi as any).verifyDownloadedTikTok;
 expect(typeof verify).toBe('function');
 expect(verify(share,videoId,canonical)).toEqual({platform:'tiktok',video_id:videoId,source_url:'https://vt.tiktok.com/ZSgLUAEhe/',canonical_url:canonical});
 expect(()=>verify(share,videoId,'https://www.tiktok.com/@other/video/7695118893425102120')).toThrow(/identity/i);
 expect(()=>verify(canonical,'7695118893425102120','https://www.tiktok.com/@other/video/7695118893425102120')).toThrow(/identity/i);
});

test('TikTok downloader obtains its identity and final URL from yt-dlp before returning the file',async()=>{
 const download=(downloader as any).downloadTikTok;
 expect(typeof download).toBe('function');
 const root=mkdtempSync(join(tmpdir(),'isymcp-tiktok-download-')),staging=join(root,'stage');mkdirSync(staging);
 const file=join(staging,'media.mp4');let argsSeen:string[]=[];
 const runner:typeof run=async(_command,args)=>{
  argsSeen=args;writeFileSync(file,'video');
  const idFlag=args.indexOf('--print-to-file');
  writeFileSync(args[idFlag+2],`${videoId}\n`);
  const pageFlag=args.indexOf('--print-to-file',idFlag+1);
  writeFileSync(args[pageFlag+2],`${canonical}\n`);
  return Buffer.from(`${JSON.stringify(file)}\n`);
 };
 try {
  const result=await download(share,staging,1024,runner);
  expect(result).toEqual({path:file,platform:'tiktok',video_id:videoId,source_url:'https://vt.tiktok.com/ZSgLUAEhe/',canonical_url:canonical});
  expect(argsSeen).toContain('--ignore-config');expect(argsSeen).toContain('--no-plugin-dirs');expect(argsSeen).toContain('--no-playlist');
  expect(argsSeen[argsSeen.indexOf('-f')+1]).toBe('best[height<=720]/best[width<=720]');
  expect(argsSeen).toContain('after_move:%(webpage_url)s');
 } finally {rmSync(root,{recursive:true,force:true});}
});
