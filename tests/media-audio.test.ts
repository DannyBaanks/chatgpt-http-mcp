import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeAudio, windowRange } from '../src/media/audio';
import { run } from '../src/media/process';
test('local audio distinguishes silence, tone and pulse and returns real PNGs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-audio-'));
 for(const [name,expression] of [['silence','0'],['tone','0.5*sin(2*PI*1000*t)'],['pulse','0.5*gte(t\\,0.9)*lte(t\\,1.1)']]) {
  const path=join(root,name+'.wav');
  await run('ffmpeg',['-v','error','-f','lavfi','-i',`aevalsrc=${expression}:s=16000:d=2`,'-c:a','pcm_f32le',path]);
  const result=await analyzeAudio(path,0,2);
  expect(result.images.length).toBe(2);
  expect(Buffer.from(result.images[0].data,'base64').subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
  if(name==='silence') {expect(result.statistics.rms).toBe(0);expect(result.statistics.silence[0].end_seconds).toBe(2);}
  if(name==='tone') expect(result.statistics.rms).toBeCloseTo(Math.SQRT1_2*0.5,3);
  if(name==='pulse') {expect(result.statistics.peak).toBeCloseTo(0.5);expect(result.statistics.silence.length).toBe(2);}
 }
 expect(()=>windowRange(0,61,100)).toThrow('Invalid window');
 expect(()=>windowRange(-1,1,2)).toThrow('Invalid window');
 await expect(run(process.execPath,['-e','setTimeout(()=>{},10000)'],100,20)).rejects.toThrow('timed out');
 await expect(run(process.execPath,['-e','process.stdout.write("123456")'],2)).rejects.toThrow('exceeds limit');
},20000);
test('graphs include only the requested audio window',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-window-'));const silence=join(root,'silence.wav'),transition=join(root,'transition.wav');
 for(const [path,expression] of [[silence,'0'],[transition,'0.5*sin(2*PI*1000*t)*gte(t\\,1)']]) await run('ffmpeg',['-v','error','-f','lavfi','-i',`aevalsrc=${expression}:s=16000:d=2`,'-c:a','pcm_f32le',path]);
 const a=await analyzeAudio(silence,0,0.5),b=await analyzeAudio(transition,0,0.5);
 expect(b.statistics.rms).toBe(0);
 expect(b.images[0].data).toBe(a.images[0].data);
 expect(b.images[1].data).toBe(a.images[1].data);
});
