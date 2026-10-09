import { MediaCatalog } from './catalog';
import { MediaImporter, youtubeSource } from './importer';
import { prepareMedia } from './preparation';
import { MediaPreparationStore } from './preparation-store';

export type MediaCommandDependencies = {
 catalog?: MediaCatalog;
 importer?: MediaImporter;
 prepare?: typeof prepareMedia;
 stdout?: (text:string)=>void;
 stderr?: (text:string)=>void;
};

export async function mediaCommand(command:string|undefined,args:string[],dependencies:MediaCommandDependencies={}) {
 const catalog=dependencies.catalog??new MediaCatalog();
 const importer=dependencies.importer??new MediaImporter(catalog);
 const out=dependencies.stdout??((text:string)=>console.log(text));
 const errorOut=dependencies.stderr??((text:string)=>console.error(text));
 if(command==='add' && args.length===1) { const {id,name,bytes,sha256}=await catalog.add(args[0]); out(JSON.stringify({id,name,bytes,sha256},null,2)); }
 else if(command==='list' && !args.length) out(JSON.stringify(catalog.list(),null,2));
 else if(command==='revoke' && args.length===1) {catalog.revoke(args[0]); out('Asset revoked; original preserved.');}
 else if(command==='prepare' && args.length===1) {
  const sourceUrl=youtubeSource(args[0]);
  let asset=catalog.findBySourceUrl(sourceUrl);
  if(asset) {
   errorOut('source: reusing registered media');
   asset=await catalog.resolve(asset.id);
  } else {
   let job=importer.start(sourceUrl),lastPhase='';
   while(job.state==='running') {
    if(job.phase!==lastPhase){lastPhase=job.phase;errorOut(`import: ${job.phase}`);}
    job=await importer.status(job.job_id,10);
   }
   if(job.state!=='complete'||!job.asset) throw Error(job.error??'Download or media validation failed');
   asset=await catalog.resolve(job.asset.id);
   if(asset.sourceUrl!==sourceUrl) throw Error('Imported media source did not match the requested URL');
  }
  const prepare=dependencies.prepare??prepareMedia;
  let manifest;
  try {
   manifest=await prepare(catalog,asset,new MediaPreparationStore(catalog.home),{onProgress:(phase,completed,total)=>{
    errorOut(`prepare: ${phase}${completed!==undefined?` ${completed}${total!==undefined?`/${total}`:''}`:''}`);
   }});
  } catch { throw Error('Media preparation failed; the registered source and verified partial results are preserved. Retry with the same URL.'); }
  if(manifest.status!=='ready') throw Error('Media preparation did not reach ready status');
  const audio=manifest.artifacts.find(item=>item.kind==='audio_scan');
  let segmentCount=0;
  if(audio) {
   try { segmentCount=Number(JSON.parse(new MediaPreparationStore(catalog.home).readArtifact(asset.id,manifest.generation_id,audio.id).toString()).total_segments)||0; }
   catch { throw Error('Prepared audio result could not be verified'); }
  }
  out(JSON.stringify({asset_id:asset.id,status:manifest.status,duration_seconds:manifest.duration_seconds??null,
   sheet_count:manifest.artifacts.filter(item=>item.kind==='contact_sheet').length,segment_count:segmentCount}));
 } else throw Error('Usage: isymcp media add <file> | list | revoke <asset_id> | prepare <youtube-url>');
}
