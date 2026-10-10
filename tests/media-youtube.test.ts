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
