import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeAudio, audioSegments, windowRange } from '../src/media/audio';
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

test('audio activity segmentation returns stable windows around short and long silences',async()=>{
 const { segmentActivity }=await import('../src/media/audio');
 const rate=16000, pcm=Buffer.alloc(rate*2*4);
 for(let i=rate*0.2;i<rate*0.8;i++) pcm.writeFloatLE(0.4*Math.sin(2*Math.PI*440*i/rate),i*4);
 for(let i=rate*0.85;i<rate*1.2;i++) pcm.writeFloatLE(0.4*Math.sin(2*Math.PI*440*i/rate),i*4);
 for(let i=rate*1.6;i<rate*1.9;i++) pcm.writeFloatLE(0.3*Math.sin(2*Math.PI*220*i/rate),i*4);
 const segments=segmentActivity(pcm,rate,0,2,{thresholdDbfs:-35,minSilenceSeconds:0.2,minSegmentSeconds:0.1,mergeGapSeconds:0.1});
 expect(segments).toHaveLength(2);
 expect(segments[0].start_seconds).toBeCloseTo(0.2,1);
 expect(segments[0].end_seconds).toBeCloseTo(1.2,1);
 expect(segments[0].peak).toBeCloseTo(0.4,2);
 expect(segments[1].start_seconds).toBeCloseTo(1.6,1);
 expect(segments[1].end_seconds).toBeCloseTo(1.9,1);
});

test('audio segment defaults preserve a 120ms pause as a boundary',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-segment-gap-')),path=join(root,'two-events.wav');
 const tone='0.5*sin(2*PI*440*t)';
 const expression=`${tone}*gte(t\\,0.1)*lte(t\\,0.4)+${tone}*gte(t\\,0.52)*lte(t\\,0.8)`;
 await run('ffmpeg',['-v','error','-f','lavfi','-i',`aevalsrc=${expression}:s=16000:d=1`,'-c:a','pcm_f32le',path]);
 const result=await audioSegments(path,0,1);
 expect(result.algorithm_version).toBe('audio-rms-activity/2');
 expect(result.parameters.mergeGapSeconds).toBe(0.1);
 expect(result.segments).toHaveLength(2);
 expect(result.segments[0].end_seconds).toBeLessThan(0.5);
 expect(result.segments[1].start_seconds).toBeGreaterThan(0.5);
 const previous=await audioSegments(path,0,1,{thresholdDbfs:-32,mergeGapSeconds:0.15,minSegmentSeconds:0.12});
 expect(previous.parameters.mergeGapSeconds).toBe(0.15);
 expect(previous.segments).toHaveLength(1);
});

test('audio analysis can inspect stereo channels independently and labels derived representation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-stereo-')),path=join(root,'stereo.wav');
 await run('ffmpeg',['-v','error','-f','lavfi','-i','aevalsrc=0.5*sin(2*PI*440*t)|0.25*sin(2*PI*440*t):s=16000:d=1','-c:a','pcm_f32le',path]);
 const result=await analyzeAudio(path,0,1,'separate');
 expect(result.statistics.source_channels).toBe(2);
 expect(result.statistics.analysis_channels).toBe(2);
 expect(result.statistics.channels.map(c=>c.name)).toEqual(['left','right']);
 expect(result.statistics.channels[0].rms).toBeCloseTo(Math.SQRT1_2*0.5,2);
 expect(result.statistics.channels[1].rms).toBeCloseTo(Math.SQRT1_2*0.25,2);
 expect(result.statistics.channel_comparison.method).toBe('Pearson correlation and L-R difference over decoded samples');
 expect(result.statistics.channel_comparison.pearson_correlation).toBeCloseTo(1,5);
 expect(result.statistics.channel_comparison.difference_rms).toBeCloseTo(Math.SQRT1_2*0.25,3);
 expect(result.statistics.channel_comparison.difference_peak).toBeCloseTo(0.25,2);
 expect(result.images.map(i=>i.label)).toEqual(['left waveform','left spectrogram','right waveform','right spectrogram']);
 for(const image of result.images)expect(Buffer.from(image.data,'base64').subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
 const mono=join(root,'mono.wav');await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1',mono]);
 await expect(analyzeAudio(mono,0,1,'separate')).rejects.toThrow('requires a two-channel stereo source');
});
