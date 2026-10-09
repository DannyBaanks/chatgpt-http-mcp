import { run } from './process';
export async function probe(path:string) {
 const data=JSON.parse((await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type,codec_name,sample_rate,channels,width,height','-of','json',path])).toString());
 const duration=Number(data.format?.duration);
 if(!Number.isFinite(duration)||duration<=0) throw Error('Media duration unavailable');
 return {duration_seconds:duration,streams:data.streams as Array<Record<string,unknown>>};
}
export function windowRange(start:number,end:number,duration:number) {
 if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end-start>60||end>duration+0.001) throw Error('Invalid window: 0 <= start < end <= duration; maximum 60 seconds');
}
export async function analyzeAudio(path:string,start:number,end:number) {
 const info=await probe(path); windowRange(start,end,info.duration_seconds);
 if(!info.streams.some(s=>s.codec_type==='audio')) throw Error('Media has no audio stream');
 const input=['-v','error','-nostdin','-protocol_whitelist','file,pipe','-ss',String(start),'-t',String(end-start),'-i',path,'-map','0:a:0'];
 const pcm=await run('ffmpeg',[...input,'-ac','1','-ar','16000','-f','f32le','pipe:1'],60*16000*4+4096);
 if(!pcm.length || pcm.length%4) throw Error('Invalid decoded audio');
 const count=pcm.length/4; let squares=0,peak=0; const silence:Array<{start_seconds:number,end_seconds:number}>=[]; let quiet:number|undefined;
 for(let offset=0;offset<count;offset+=1600) {
  let blockSquares=0; const n=Math.min(1600,count-offset);
  for(let j=0;j<n;j++){const value=pcm.readFloatLE((offset+j)*4); if(!Number.isFinite(value)) throw Error('Nonfinite audio'); squares+=value*value; blockSquares+=value*value; peak=Math.max(peak,Math.abs(value));}
  if(Math.sqrt(blockSquares/n)<=0.00316227766) quiet??=offset/16000;
  else if(quiet!==undefined){silence.push({start_seconds:start+quiet,end_seconds:start+offset/16000});quiet=undefined;}
 }
 if(quiet!==undefined) silence.push({start_seconds:start+quiet,end_seconds:start+count/16000});
 const images=[];
 for(const filter of ['showwavespic=s=800x240:colors=white','showspectrumpic=s=800x400:legend=1:scale=log']) {
  const png=await run('ffmpeg',[...input,'-ac','1','-lavfi','aresample=16000,'+filter,'-an','-frames:v','1','-threads','1','-c:v','png','-f','image2pipe','pipe:1']);
  if(!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Invalid audio image');
  images.push({type:'image' as const,mimeType:'image/png',data:png.toString('base64')});
 }
 return {statistics:{sample_rate:16000,channels:1,decoded_seconds:count/16000,rms:Math.sqrt(squares/count),peak,silence_threshold_dbfs:-50,silence_resolution_seconds:0.1,silence},images};
}
