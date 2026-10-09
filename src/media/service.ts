import { contactSheet } from './contact-sheet';
import { MediaImporter } from './importer';
import { withinDeadline } from './deadline';
import { MediaCatalog } from './catalog';
import { probe, analyzeAudio, audioSegments, windowRange } from './audio';
import { videoFrame } from './video-vision';
export class MediaService {
 private busy=false;
 private importer:MediaImporter;
 constructor(public catalog=new MediaCatalog()){this.importer=new MediaImporter(catalog);}
 async call(name:string,args:any) {
  if(name==='media_import_status') {
   try {const result=await this.importer.status(args.job_id,args.wait_seconds??0);return {isError:result.state==='failed',content:[{type:'text' as const,text:JSON.stringify(result)}]};}
   catch(error){return {isError:true,content:[{type:'text' as const,text:String(error instanceof Error?error.message:error)}]};}
  }
  if(name==='media_import') {
   try {if(this.busy)throw Error('Media worker busy; retry after current query finishes');return {content:[{type:'text' as const,text:JSON.stringify(this.importer.start(args.url))}]};}
   catch(error){return {isError:true,content:[{type:'text' as const,text:String(error instanceof Error?error.message:error)}]};}
  }
  if(name==='media_list') {
   try {
    const offset=args.offset??0;
    if(!Number.isInteger(offset)||offset<0) throw Error('Invalid list offset');
    const all=this.catalog.list().sort((a,b)=>a.id.localeCompare(b.id));
    const assets=all.slice(offset,offset+20);
    return {content:[{type:'text' as const,text:JSON.stringify({assets,next_offset:offset+assets.length<all.length?offset+assets.length:null})}]};
   } catch(error) {return {isError:true,content:[{type:'text' as const,text:'Media catalog unavailable or invalid offset'}]};}
  }
  if(this.busy||this.importer.active) return {isError:true,content:[{type:'text' as const,text:'Media worker busy; retry after current query finishes'}]};
  this.busy=true;
  try {
   if(!['media_info','audio_analyze','audio_segments','video_frame','video_contact_sheet'].includes(name)) {this.busy=false;throw Error('Unknown media tool');}
   return await withinDeadline(()=>this.catalog.snapshot(args.asset_id,async(asset,path)=>{
    let result:any,images:any[]=[];
    const window=['audio_analyze','audio_segments','video_contact_sheet'].includes(name)?{start_seconds:args.start_seconds,end_seconds:args.end_seconds}:name==='video_frame'?{timestamp_seconds:args.timestamp_seconds}:undefined;
    if(name==='media_info') result=await probe(path);
    else if(name==='audio_analyze') {const audio=await analyzeAudio(path,args.start_seconds,args.end_seconds,args.channel??'mix');result=audio.statistics;images=audio.images;}
    else if(name==='audio_segments') result=await audioSegments(path,args.start_seconds,args.end_seconds,{thresholdDbfs:args.threshold_dbfs??-32,mergeGapSeconds:args.merge_gap_seconds??0.1,minSegmentSeconds:args.min_segment_seconds??0.12});
    else if(name==='video_contact_sheet'){const sheet=await contactSheet(path,args.start_seconds,args.end_seconds,args.columns??4);result=sheet.metadata;images=[sheet.image];}
    else {
     const info=await probe(path); if(!info.streams.some(s=>s.codec_type==='video')) throw Error('Media has no video stream');
     const t=args.timestamp_seconds; windowRange(t,t+0.000001,info.duration_seconds); if(t>=info.duration_seconds) throw Error('Timestamp must precede end of video');
     images=[await videoFrame(path,t)];result={width_limit:640};
    }
    const method=name==='media_info'?'ffprobe source container and stream metadata':name==='video_frame'?'Video Vision extract_frame_at':name==='video_contact_sheet'?'FFmpeg contact sheet; labelled sample times; aspect ratio preserved':name==='audio_segments'?'FFmpeg RMS activity segmentation; mono 16 kHz':`FFmpeg/ffprobe; audio ${args.channel&&args.channel!=='mix'?`channel ${args.channel}`:'mono mix'} at 16 kHz`;
    return {content:[{type:'text' as const,text:JSON.stringify({asset_id:asset.id,sha256:asset.sha256,source_url:asset.sourceUrl,window,method,version:'isymcp-media/1',result,limitations:name==='audio_analyze'?'Waveform and spectrum are acoustic measurements, not native listening or sound identification.':undefined})},...images]};
   }),60000,()=>{this.busy=false;});
  } catch(error) { return {isError:true,content:[{type:'text' as const,text:String(error instanceof Error?error.message:error).replaceAll(this.catalog.home,'[media-state]')}]}; }
 }
}
