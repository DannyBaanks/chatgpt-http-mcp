import { contactSheet } from './contact-sheet';
import { MediaImporter } from './importer';
import { withinDeadline } from './deadline';
import { MediaCatalog } from './catalog';
import { probe, analyzeAudio, audioSegments, audioScan, windowRange } from './audio';
import { videoFrame } from './video-vision';
import { youtubeSource } from './importer';
import { MediaPreparationStore } from './preparation-store';
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
  if(name==='media_lookup') return this.lookup(args);
  if(this.busy||this.importer.active) return {isError:true,content:[{type:'text' as const,text:'Media worker busy; retry after current query finishes'}]};
  this.busy=true;
  try {
   if(!['media_info','audio_analyze','audio_segments','audio_scan','video_frame','video_contact_sheet'].includes(name)) {this.busy=false;throw Error('Unknown media tool');}
   return await withinDeadline(()=>this.catalog.snapshot(args.asset_id,async(asset,path)=>{
    let result:any,images:any[]=[],window:any;
    window=['audio_analyze','audio_segments','video_contact_sheet'].includes(name)?{start_seconds:args.start_seconds,end_seconds:args.end_seconds}:name==='video_frame'?{timestamp_seconds:args.timestamp_seconds}:undefined;
    if(name==='media_info') result=await probe(path);
    else if(name==='audio_analyze') {const audio=await analyzeAudio(path,args.start_seconds,args.end_seconds,args.channel??'mix');result=audio.statistics;images=audio.images;}
    else if(name==='audio_segments') result=await audioSegments(path,args.start_seconds,args.end_seconds,{thresholdDbfs:args.threshold_dbfs??-32,mergeGapSeconds:args.merge_gap_seconds??0.1,minSegmentSeconds:args.min_segment_seconds??0.12});
    else if(name==='audio_scan') {result=await audioScan(path,args.start_seconds??0,args.end_seconds,args.chunk_seconds??120,{thresholdDbfs:args.threshold_dbfs??-32,mergeGapSeconds:args.merge_gap_seconds??0.1,minSegmentSeconds:args.min_segment_seconds??0.12});window=result.window;}
    else if(name==='video_contact_sheet'){const sheet=await contactSheet(path,args.start_seconds,args.end_seconds,args.columns??4);result=sheet.metadata;images=[sheet.image];}
    else {
     const info=await probe(path); if(!info.streams.some(s=>s.codec_type==='video')) throw Error('Media has no video stream');
     const t=args.timestamp_seconds; windowRange(t,t+0.000001,info.duration_seconds); if(t>=info.duration_seconds) throw Error('Timestamp must precede end of video');
     images=[await videoFrame(path,t)];result={width_limit:640};
    }
    const method=name==='media_info'?'ffprobe source container and stream metadata':name==='video_frame'?'Video Vision extract_frame_at':name==='video_contact_sheet'?'FFmpeg contact sheet; labelled sample times; aspect ratio preserved':name==='audio_segments'?'FFmpeg RMS activity segmentation; mono 16 kHz':name==='audio_scan'?'FFmpeg full-window audio activity scan in chunks of at most 120 seconds':`FFmpeg/ffprobe; audio ${args.channel&&args.channel!=='mix'?`channel ${args.channel}`:'mono mix'} at 16 kHz`;
    return {content:[{type:'text' as const,text:JSON.stringify({asset_id:asset.id,sha256:asset.sha256,source_url:asset.sourceUrl,window,method,version:'isymcp-media/1',result,limitations:name==='audio_analyze'?'Waveform and spectrum are acoustic measurements, not native listening or sound identification.':undefined})},...images]};
   }),name==='audio_scan'?300000:60000,()=>{this.busy=false;});
  } catch(error) { return {isError:true,content:[{type:'text' as const,text:String(error instanceof Error?error.message:error).replaceAll(this.catalog.home,'[media-state]')}]}; }
 }

 private async lookup(args:any) {
  const text=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
  try {
   const sourceUrl=youtubeSource(String(args.url??''));
   if(args.sheet_index!==undefined&&(!Number.isInteger(args.sheet_index)||args.sheet_index<0))throw Error('Invalid sheet_index');
   const asset=this.catalog.findBySourceUrl(sourceUrl);
   if(!asset)return text({found:false,status:'not_found'});
   const verified=await this.catalog.resolve(asset.id);
   if(verified.sourceUrl!==sourceUrl)throw Error('Registered media source mismatch');
   const store=new MediaPreparationStore(this.catalog.home),manifest=store.current(asset.id);
   if(!manifest)return text({found:true,status:'not_prepared',asset_id:verified.id,source_url:sourceUrl,source_sha256:verified.sha256});
   if(manifest.source_sha256!==verified.sha256||manifest.source_url!==sourceUrl)throw Error('Prepared media source mismatch');
   const audioArtifact=manifest.artifacts.find(item=>item.kind==='audio_scan');
   const audio=audioArtifact?JSON.parse(store.readArtifact(asset.id,manifest.generation_id,audioArtifact.id).toString()):undefined;
   if(!manifest.unavailable_modalities?.includes('audio')&&!audio)throw Error('Prepared audio result missing');
   const sheets=manifest.artifacts.filter(item=>item.kind==='contact_sheet').sort((a,b)=>a.id.localeCompare(b.id)).map((item,index)=>{
    if(item.id!==`sheet-${String(index).padStart(3,'0')}`)throw Error('Prepared contact-sheet index invalid');
    const parameters=item.parameters as {samples?:unknown[]};
    return {index,time_range:item.time_range,samples:parameters?.samples??[]};
   });
   let selectedSheet:unknown;
   const images=[];
   if(args.sheet_index!==undefined) {
    if(args.sheet_index>=sheets.length)throw Error('sheet_index is out of range');
    const item=manifest.artifacts.find(artifact=>artifact.id===`sheet-${String(args.sheet_index).padStart(3,'0')}`)!;
    const data=store.readArtifact(asset.id,manifest.generation_id,item.id);
    selectedSheet={index:args.sheet_index,time_range:item.time_range,samples:(item.parameters as {samples?:unknown[]})?.samples??[]};
    images.push({type:'image' as const,mimeType:'image/jpeg',data:data.toString('base64')});
   }
   const result={found:true,status:'ready',asset_id:verified.id,source_url:sourceUrl,source_sha256:verified.sha256,bytes:verified.bytes,
    generation_id:manifest.generation_id,prepared_at:manifest.prepared_at,duration_seconds:manifest.duration_seconds,streams:manifest.streams,
    unavailable_modalities:manifest.unavailable_modalities??[],pipeline_versions:manifest.pipeline_versions??{},audio_scan:audio??null,
    sheets,...(selectedSheet?{selected_sheet:selectedSheet}:{})};
   return {content:[{type:'text' as const,text:JSON.stringify(result)},...images]};
  } catch(error) {
   const message=String(error instanceof Error?error.message:'Media lookup failed').replaceAll(this.catalog.home,'[media-state]');
   return {isError:true,content:[{type:'text' as const,text:message}]};
  }
 }
}
