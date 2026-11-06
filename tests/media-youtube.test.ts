import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {downloadYouTube} from '../src/media/youtube';
import {run} from '../src/media/process';

test('download records the post-move YouTube ID and validates it against the canonical URL',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-youtube-download-'));const staging=join(root,'stage');mkdirSync(staging);const source=join(staging,'media.mp4');writeFileSync(source,'video');let argsSeen:string[]=[];
 const runner:typeof run=async(_command,args)=>{argsSeen=args;const receiptPath=args[args.indexOf('--print-to-file')+2];writeFileSync(receiptPath,'abcdefghijk\n');return Buffer.from(`${JSON.stringify(source)}\n`);};
 try {
  const result=await downloadYouTube('https://youtu.be/abcdefghijk',staging,1024,runner);
  expect(result).toEqual({path:source,video_id:'abcdefghijk',source_url:'https://www.youtube.com/watch?v=abcdefghijk'});
  expect(argsSeen).toContain('--ignore-config');expect(argsSeen).toContain('--no-plugin-dirs');
  expect(argsSeen.slice(argsSeen.indexOf('--print-to-file'),argsSeen.indexOf('--print-to-file')+2)).toEqual(['--print-to-file','after_move:%(id)s']);
  expect(readFileSync(argsSeen[argsSeen.indexOf('--print-to-file')+2],'utf8')).toBe('abcdefghijk\n');
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('download rejects a post-move ID that differs from the canonical URL',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-youtube-mismatch-'));const staging=join(root,'stage');mkdirSync(staging);const source=join(staging,'media.mp4');writeFileSync(source,'video');
 const runner:typeof run=async(_command,args)=>{writeFileSync(args[args.indexOf('--print-to-file')+2],'lmnopqrstuv\n');return Buffer.from(`${JSON.stringify(source)}\n`);};
 try {await expect(downloadYouTube('https://youtu.be/abcdefghijk',staging,1024,runner)).rejects.toThrow('did not match');}
 finally {rmSync(root,{recursive:true,force:true});}
});

test('download retries through the embedded web client when YouTube demands bot confirmation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-youtube-retry-'));const staging=join(root,'stage');mkdirSync(staging);const source=join(staging,'media.mp4');writeFileSync(source,'video');const calls:string[][]=[];
 const runner:typeof run=async(_command,args)=>{calls.push(args);if(calls.length===1)throw Error("Media process failed (1): ERROR: [youtube] abcdefghijk: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.");writeFileSync(args[args.indexOf('--print-to-file')+2],'abcdefghijk\n');return Buffer.from(`${JSON.stringify(source)}\n`);};
 try {
  const result=await downloadYouTube('https://youtu.be/abcdefghijk',staging,1024,runner);
  expect(result.video_id).toBe('abcdefghijk');expect(calls.length).toBe(2);
  expect(calls[0]).not.toContain('--extractor-args');
  expect(calls[1][calls[1].indexOf('--extractor-args')+1]).toBe('youtube:player_client=web_embedded');
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('download does not retry when the downloader fails for other reasons',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-youtube-noretry-'));const staging=join(root,'stage');mkdirSync(staging);let calls=0;
 const runner:typeof run=async()=>{calls++;throw Error('Media process failed (1): ERROR: [youtube] abcdefghijk: This video is unavailable');};
 try {await expect(downloadYouTube('https://youtu.be/abcdefghijk',staging,1024,runner)).rejects.toThrow('This video is unavailable');expect(calls).toBe(1);}
 finally {rmSync(root,{recursive:true,force:true});}
});

test('download surfaces the original failure when the embedded retry also fails',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-youtube-retry-fail-'));const staging=join(root,'stage');mkdirSync(staging);let calls=0;
 const runner:typeof run=async()=>{calls++;throw Error(calls===1?"Media process failed (1): ERROR: [youtube] abcdefghijk: Sign in to confirm you're not a bot":"Media process failed (1): ERROR: [youtube] abcdefghijk: Unable to extract player response");};
 try {await expect(downloadYouTube('https://youtu.be/abcdefghijk',staging,1024,runner)).rejects.toThrow('not a bot');expect(calls).toBe(2);}
 finally {rmSync(root,{recursive:true,force:true});}
});
