import { run } from './process';
import { deflateSync } from 'node:zlib';

const RATE=16000;
export const MAX_AUDIO_CHUNK_SECONDS=120;
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
export type AudioChannel='mix'|'left'|'right'|'separate';
export type SegmentOptions={thresholdDbfs:number;mergeGapSeconds:number;minSegmentSeconds:number};

export async function probe(path:string) {
 const data=JSON.parse((await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type,codec_name,sample_rate,channels,channel_layout,width,height','-of','json',path])).toString());
 const duration=Number(data.format?.duration);
 if(!Number.isFinite(duration)||duration<=0) throw Error('Media duration unavailable');
 return {duration_seconds:duration,streams:data.streams as Array<Record<string,unknown>>};
}
export function windowRange(start:number,end:number,duration:number,maxSeconds=60) {
 if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(maxSeconds)||maxSeconds<=0||start<0||end<=start||end-start>maxSeconds||end>duration+0.001) throw Error(`Invalid window: 0 <= start < end <= duration; maximum ${maxSeconds} seconds`);
}
export function chunkAudioRange(start:number,end:number,chunkSeconds=MAX_AUDIO_CHUNK_SECONDS) {
 if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(chunkSeconds)||start<0||end<=start||chunkSeconds<=0||chunkSeconds>MAX_AUDIO_CHUNK_SECONDS) throw Error('Invalid audio scan: start >= 0, end > start, and chunk_seconds must be between 0 and 120');
 const chunks:Array<{start_seconds:number;end_seconds:number}>=[];
 for(let cursor=start;cursor<end;){const next=Math.min(end,cursor+chunkSeconds);if(next<=cursor)throw Error('Invalid audio chunk boundary');chunks.push({start_seconds:cursor,end_seconds:next});cursor=next;}
 return chunks;
}
function audioStream(info:Awaited<ReturnType<typeof probe>>) {
 const stream=info.streams.find(s=>s.codec_type==='audio');
 if(!stream) throw Error('Media has no audio stream');
 const channels=Number(stream.channels);
 if(!Number.isInteger(channels)||channels<1||channels>8) throw Error('Unsupported audio channel count');
 return {stream,channels,channelLayout:String(stream.channel_layout||'unknown')};
}
function inputArgs(path:string,start:number,end:number) {
 return ['-v','error','-nostdin','-protocol_whitelist','file,pipe','-ss',String(start),'-t',String(end-start),'-i',path,'-map','0:a:0'];
}
function channelFilter(channel:'left'|'right') {
 return `pan=mono|c0=${channel==='left'?'FL':'FR'},aresample=${RATE}`;
}
async function decode(path:string,start:number,end:number,channel:AudioChannel) {
 const input=inputArgs(path,start,end);
 const selected=channel==='left'||channel==='right';
 const args=selected?['-af',channelFilter(channel),'-f','f32le','pipe:1']:['-ac','1','-ar',String(RATE),'-f','f32le','pipe:1'];
 const pcm=await run('ffmpeg',[...input,...args],MAX_AUDIO_CHUNK_SECONDS*RATE*4+4096);
 if(!pcm.length||pcm.length%4) throw Error('Invalid decoded audio');
 return pcm;
}
type Measures={decoded_seconds:number;rms:number;peak:number;silence_threshold_dbfs:-50;silence_resolution_seconds:number;silence:Array<{start_seconds:number;end_seconds:number}>};
function compareChannels(left:Buffer,right:Buffer,leftRms:number,rightRms:number) {
 if(left.length!==right.length||left.length===0||left.length%4!==0)throw Error('Stereo channel samples do not align');
 const count=left.length/4;let meanLeft=0,meanRight=0,differenceSquares=0,differencePeak=0;
 for(let i=0;i<count;i++) {
  const l=left.readFloatLE(i*4),r=right.readFloatLE(i*4);
  if(!Number.isFinite(l)||!Number.isFinite(r))throw Error('Nonfinite audio');
  meanLeft+=l/count;meanRight+=r/count;
  const difference=l-r;differenceSquares+=difference*difference;differencePeak=Math.max(differencePeak,Math.abs(difference));
 }
 let covariance=0,leftSquares=0,rightSquares=0;
 for(let i=0;i<count;i++) {
  const l=left.readFloatLE(i*4)-meanLeft,r=right.readFloatLE(i*4)-meanRight;
  covariance+=l*r;leftSquares+=l*l;rightSquares+=r*r;
 }
 const denominator=Math.sqrt(leftSquares*rightSquares),differenceRms=Math.sqrt(differenceSquares/count);
 return {method:'Pearson correlation and L-R difference over decoded samples',pearson_correlation:denominator>0?covariance/denominator:null,difference_rms:differenceRms,difference_peak:differencePeak,difference_rms_over_mean_channel_rms:(leftRms+rightRms)>0?differenceRms/((leftRms+rightRms)/2):null};
}
function measure(pcm:Buffer,start:number):Measures {
 const count=pcm.length/4;let squares=0,peak=0;const silence:Array<{start_seconds:number;end_seconds:number}>=[];let quiet:number|undefined;
 for(let offset=0;offset<count;offset+=1600) {
  let blockSquares=0;const n=Math.min(1600,count-offset);
  for(let j=0;j<n;j++){const value=pcm.readFloatLE((offset+j)*4);if(!Number.isFinite(value))throw Error('Nonfinite audio');squares+=value*value;blockSquares+=value*value;peak=Math.max(peak,Math.abs(value));}
  if(Math.sqrt(blockSquares/n)<=0.00316227766) quiet??=offset/RATE;
  else if(quiet!==undefined){silence.push({start_seconds:start+quiet,end_seconds:start+offset/RATE});quiet=undefined;}
 }
 if(quiet!==undefined)silence.push({start_seconds:start+quiet,end_seconds:start+count/RATE});
 return {decoded_seconds:count/RATE,rms:Math.sqrt(squares/count),peak,silence_threshold_dbfs:-50,silence_resolution_seconds:0.1,silence};
}
async function render(path:string,start:number,end:number,channel:AudioChannel) {
 const input=inputArgs(path,start,end), selected=channel==='left'||channel==='right';
 const prefix=selected?channelFilter(channel)+',':'aformat=channel_layouts=mono,';
 const images=[];
 for(const [label,filter] of [['spectrogram','showspectrumpic=s=800x400:legend=1:scale=log']] as const) {
  const png=await run('ffmpeg',[...input,'-filter_complex',`[0:a:0]${prefix}aresample=${RATE},${filter}[v]`,'-map','[v]','-an','-frames:v','1','-threads','1','-c:v','png','-f','image2pipe','pipe:1']);
  if(!png.subarray(0,8).equals(PNG))throw Error('Invalid audio image');
  const channelName=channel==='mix'?'mono mix':channel;
  images.push({type:'image' as const,mimeType:'image/png',data:png.toString('base64'),label:`${channelName} ${label}`});
 }
 return images;
}

const GLYPHS:Record<string,string[]>={
 '0':['111','101','101','101','111'],'1':['010','110','010','010','111'],'2':['110','001','010','100','111'],'3':['110','001','010','001','110'],'4':['101','101','111','001','001'],'5':['111','100','110','001','110'],'6':['011','100','110','101','010'],'7':['111','001','010','010','010'],'8':['010','101','010','101','010'],'9':['010','101','011','001','110'],
 '-':['000','000','111','000','000'],'+':['000','010','111','010','000'],'.':['000','000','000','000','010'],'s':['011','100','010','001','110'],'k':['101','101','110','101','101'],'H':['101','101','111','101','101'],'z':['111','001','010','100','111'],
 };
let crcTable:Uint32Array|undefined;
function crc32(data:Buffer){if(!crcTable)crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});let c=0xffffffff;for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function pngChunk(type:string,data:Buffer){const tag=Buffer.from(type),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc32(Buffer.concat([tag,data])));return Buffer.concat([size,tag,data,sum]);}
function waveformPng(pcm:Buffer,start:number,channel:AudioChannel){
 const w=800,h=252,left=76,right=790,top=16,bottom=202,axis=230,span=right-left,frames=pcm.length/4,seconds=frames/RATE;
 const pixels=Buffer.alloc(w*h*3),color:Record<string,[number,number,number]>={mix:[225,235,255],left:[73,199,255],right:[255,179,71]};
 const put=(x:number,y:number,r:number,g:number,b:number)=>{if(x<0||x>=w||y<0||y>=h)return;const i=(y*w+x)*3;pixels[i]=r;pixels[i+1]=g;pixels[i+2]=b;};
 const line=(x1:number,y1:number,x2:number,y2:number,r:number,g:number,b:number)=>{const dx=Math.abs(x2-x1),sx=x1<x2?1:-1,dy=-Math.abs(y2-y1),sy=y1<y2?1:-1;let err=dx+dy;for(;;){put(x1,y1,r,g,b);if(x1===x2&&y1===y2)break;const e=2*err;if(e>=dy){err+=dy;x1+=sx;}if(e<=dx){err+=dx;y1+=sy;}}};
 const text=(value:string,x:number,y:number,r=190,g=200,b=215)=>{for(const char of value){const glyph=GLYPHS[char];if(glyph)for(let gy=0;gy<glyph.length;gy++)for(let gx=0;gx<glyph[gy].length;gx++)if(glyph[gy][gx]==='1')for(let sy=0;sy<2;sy++)for(let sx=0;sx<2;sx++)put(x+gx*2+sx,y+gy*2+sy,r,g,b);x+=8;}};
 const yFor=(a:number)=>Math.round(top+(1-Math.max(-1,Math.min(1,a)))*((bottom-top)/2));
 for(const value of [-1,-0.5,0,0.5,1]){const y=yFor(value),bright=value===0?75:42;line(left,y,right,y,bright,bright,bright);const label=(value>0?'+':'')+value.toFixed(value%1===0?0:1);text(label,2,y-5);}
 line(left,top,left,bottom,105,115,130);line(left,axis,right,axis,105,115,130);
 const [r,g,b]=color[channel==='left'||channel==='right'?channel:'mix'];
 for(let x=0;x<span;x++) {const from=Math.floor(x*frames/span),to=Math.max(from+1,Math.min(frames,Math.floor((x+1)*frames/span)));let lo=1,hi=-1;for(let i=from;i<to;i++){const v=pcm.readFloatLE(i*4);if(!Number.isFinite(v))throw Error('Nonfinite audio');lo=Math.min(lo,v);hi=Math.max(hi,v);}const y1=yFor(hi),y2=yFor(lo);line(left+x,y1,left+x,Math.max(y1+1,y2),r,g,b);}
 for(let tick=0;tick<=4;tick++){const x=left+Math.round(span*tick/4),time=start+seconds*tick/4;line(x,axis,x,axis+5,150,160,175);const label=`${time.toFixed(2)}s`;text(label,Math.max(left,Math.min(right-label.length*8,x-label.length*4)),axis+9);}
 text(`${channel==='left'?'L':channel==='right'?'R':'MIX'} 16kHz`,left,2,160,175,195);
 const raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++)pixels.copy(raw,y*(w*3+1)+1,y*w*3,(y+1)*w*3);
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(raw)),pngChunk('IEND',Buffer.alloc(0))]);
}
export async function analyzeAudio(path:string,start:number,end:number,channel:AudioChannel='mix') {
 const info=await probe(path);windowRange(start,end,info.duration_seconds,MAX_AUDIO_CHUNK_SECONDS);
 const {channels:sourceChannels,channelLayout}=audioStream(info);
 if(channel==='left'||channel==='right'||channel==='separate')if(sourceChannels!==2||channelLayout!=='stereo')throw Error('Left/right inspection requires a two-channel stereo source');
 const mixedPcm=await decode(path,start,end,'mix'),mixed=measure(mixedPcm,start);
 const selected:('left'|'right')[]=channel==='separate'?['left','right']:channel==='left'||channel==='right'?[channel]:[];
 const channelPcms=new Map<'left'|'right',Buffer>(),perChannel=[];
 for(const name of selected){const pcm=await decode(path,start,end,name);channelPcms.set(name,pcm);const stats=measure(pcm,start);perChannel.push({name,...stats});}
 const channelComparison=channel==='separate'?compareChannels(channelPcms.get('left')!,channelPcms.get('right')!,perChannel[0].rms,perChannel[1].rms):undefined;
 const sources:('mix'|'left'|'right')[]=channel==='separate'?['left','right']:[channel==='left'||channel==='right'?channel:'mix'];
 const images=[];const imageOrder:string[]=[];
 for(const name of sources){const display=name==='mix'?'mono mix':name,pcm=name==='mix'?mixedPcm:channelPcms.get(name)!,wave=waveformPng(pcm,start,name);imageOrder.push(`${display} waveform`);images.push({type:'image' as const,mimeType:'image/png',data:wave.toString('base64'),label:`${display} waveform`});imageOrder.push(`${display} spectrogram`);images.push(...await render(path,start,end,name));}
 const primary=channel==='left'?perChannel[0]:channel==='right'?perChannel[0]:mixed;
 return {statistics:{sample_rate:RATE,source_channels:sourceChannels,analysis_channels:channel==='separate'?2:1,channel_mode:channel,decoded_seconds:primary.decoded_seconds,rms:primary.rms,peak:primary.peak,silence_threshold_dbfs:-50,silence_resolution_seconds:0.1,silence:primary.silence,channels:perChannel.length?perChannel:undefined,channel_comparison:channelComparison,image_order:imageOrder,waveform_axes:'absolute source seconds; linear full-scale amplitude ±1 (values clipped in display)',spectrogram_axes:'log frequency and seconds relative to the requested interval start; add start_seconds for absolute source time'},images};
}

export function segmentActivity(pcm:Buffer,sampleRate:number,start:number,end:number,options:SegmentOptions) {
 if(sampleRate<=0||pcm.length%4||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw Error('Invalid decoded audio');
 const count=pcm.length/4,frame=Math.max(1,Math.round(sampleRate/100)),threshold=10**(options.thresholdDbfs/20),rmsByFrame:number[]=[];
 for(let offset=0;offset<count;offset+=frame){const n=Math.min(frame,count-offset);let sum=0;for(let i=0;i<n;i++){const x=pcm.readFloatLE((offset+i)*4);if(!Number.isFinite(x))throw Error('Nonfinite audio');sum+=x*x;}rmsByFrame.push(Math.sqrt(sum/n));}
 const active=rmsByFrame.map(v=>v>=threshold),bridge=Math.floor(options.mergeGapSeconds*sampleRate/frame);
 for(let i=0;i<active.length;){if(active[i]){i++;continue;}const begin=i;while(i<active.length&&!active[i])i++;if(begin>0&&i<active.length&&i-begin<=bridge)for(let j=begin;j<i;j++)active[j]=true;}
 const minFrames=Math.ceil(options.minSegmentSeconds*sampleRate/frame),out=[];let i=0;
 while(i<active.length){if(!active[i]){i++;continue;}const first=i;while(i<active.length&&active[i])i++;const last=i;const sampleStart=first*frame,sampleEnd=Math.min(last*frame,count);if(last-first<minFrames)continue;
  let squares=0,peak=0;for(let j=sampleStart;j<sampleEnd;j++){const x=pcm.readFloatLE(j*4);squares+=x*x;peak=Math.max(peak,Math.abs(x));}
  out.push({start_seconds:Number((start+sampleStart/sampleRate).toFixed(3)),end_seconds:Number((start+sampleEnd/sampleRate).toFixed(3)),duration_seconds:Number(((sampleEnd-sampleStart)/sampleRate).toFixed(3)),rms:Math.sqrt(squares/(sampleEnd-sampleStart)),peak});
 }
 if(out.length>100)throw Error('Too many audio segments; narrow the requested range or adjust the acoustic threshold');
 return out;
}
export async function audioSegments(path:string,start:number,end:number,options:SegmentOptions={thresholdDbfs:-32,mergeGapSeconds:0.1,minSegmentSeconds:0.12}) {
 const info=await probe(path);windowRange(start,end,info.duration_seconds,MAX_AUDIO_CHUNK_SECONDS);audioStream(info);
 const pcm=await decode(path,start,end,'mix');
 return {sample_rate:RATE,analysis_channels:1,decoded_seconds:pcm.length/4/RATE,method:'100 Hz RMS activity threshold on mono 16 kHz audio',algorithm_version:'audio-rms-activity/2',parameters:{...options,resolution_seconds:0.01},segments:segmentActivity(pcm,RATE,start,end,options),limitations:'Detects acoustic activity, not speech. Music, effects and noise can create segments; quiet speech can be missed. Use audio_analyze on a returned interval to inspect its waveform and spectrogram.'};
}
export async function audioScan(path:string,start=0,end?:number,chunkSeconds=MAX_AUDIO_CHUNK_SECONDS,options:SegmentOptions={thresholdDbfs:-32,mergeGapSeconds:0.1,minSegmentSeconds:0.12}) {
 const info=await probe(path),stream=audioStream(info),scanEnd=end??info.duration_seconds;
 if(!Number.isFinite(start)||!Number.isFinite(scanEnd)||start<0||scanEnd<=start||scanEnd>info.duration_seconds+0.001)throw Error('Invalid audio scan window: 0 <= start < end <= duration');
 const chunks=chunkAudioRange(start,Math.min(scanEnd,info.duration_seconds),chunkSeconds),results=[];
 for(let index=0;index<chunks.length;index++){
  const chunk=chunks[index],analysis=await audioSegments(path,chunk.start_seconds,chunk.end_seconds,options);
  results.push({index:index+1,...chunk,decoded_seconds:analysis.decoded_seconds,segment_count:analysis.segments.length,segments:analysis.segments});
 }
 return {window:{start_seconds:start,end_seconds:Math.min(scanEnd,info.duration_seconds)},duration_seconds:info.duration_seconds,chunk_seconds:chunkSeconds,chunk_count:results.length,sample_rate:RATE,source_channels:stream.channels,analysis_channels:1,method:'Sequential 100 Hz RMS activity segmentation on mono 16 kHz audio; absolute source timestamps',algorithm_version:'audio-rms-activity/2',parameters:{...options,resolution_seconds:0.01},total_segments:results.reduce((count,chunk)=>count+chunk.segment_count,0),chunks:results,limitations:'Covers the requested audio window in chronological chunks; detects acoustic activity, not speech. Music, effects and noise can create segments; quiet speech can be missed. Each chunk is segmented independently, so activity can split at chunk boundaries. Times are absolute within the source. Use audio_analyze on a returned interval (up to 120 seconds) to inspect waveform and spectrogram; this is not native listening or transcription.'};
}
