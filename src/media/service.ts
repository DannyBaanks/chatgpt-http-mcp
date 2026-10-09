import { withinDeadline } from './deadline';
import { MediaCatalog } from './catalog';
import { probe, analyzeAudio, windowRange } from './audio';
import { videoFrame } from './video-vision';
export class MediaService {
 private busy=false;
 constructor(public catalog=new MediaCatalog()){}
 async call(name:string,args:any) {
  if(name==='media_list') {
   try {
    const offset=args.offset??0;
    if(!Number.isInteger(offset)||offset<0) throw Error('Invalid list offset');
    const all=this.catalog.list().sort((a,b)=>a.id.localeCompare(b.id));
    const assets=all.slice(offset,offset+20);
    return {content:[{type:'text' as const,text:JSON.stringify({assets,next_offset:offset+assets.length<all.length?offset+assets.length:null})}]};
   } catch(error) {return {isError:true,content:[{type:'text' as const,text:'Media catalog unavailable or invalid offset'}]};}
  }
  if(this.busy) return {isError:true,content:[{type:'text' as const,text:'Media worker busy; retry after current query finishes'}]};
  this.busy=true;
  try {
   if(!['media_info','audio_analyze','video_frame'].includes(name)) {this.busy=false;throw Error('Unknown media tool');}
   return await withinDeadline(()=>this.catalog.snapshot(args.asset_id,async(asset,path)=>{
    let result:any,images:any[]=[];
    const window=name==='audio_analyze'?{start_seconds:args.start_seconds,end_seconds:args.end_seconds}:name==='video_frame'?{timestamp_seconds:args.timestamp_seconds}:undefined;
    if(name==='media_info') result=await probe(path);
    else if(name==='audio_analyze') {const audio=await analyzeAudio(path,args.start_seconds,args.end_seconds);result=audio.statistics;images=audio.images;}
    else {
     const info=await probe(path); if(!info.streams.some(s=>s.codec_type==='video')) throw Error('Media has no video stream');
     const t=args.timestamp_seconds; windowRange(t,t+0.000001,info.duration_seconds); if(t>=info.duration_seconds) throw Error('Timestamp must precede end of video');
     images=[await videoFrame(path,t)];result={width_limit:640};
    }
    return {content:[{type:'text' as const,text:JSON.stringify({asset_id:asset.id,sha256:asset.sha256,window,method:name==='video_frame'?'Video Vision extract_frame_at':'FFmpeg/ffprobe; audio mono 16 kHz',version:'isymcp-media/1',result,limitations:name==='audio_analyze'?'Waveform and spectrum are acoustic measurements, not native listening or sound identification.':undefined})},...images]};
   }),60000,()=>{this.busy=false;});
  } catch(error) { return {isError:true,content:[{type:'text' as const,text:String(error instanceof Error?error.message:error).replaceAll(this.catalog.home,'[media-state]')}]}; }
 }
}
