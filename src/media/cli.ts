import { createInterface } from 'node:readline/promises';
import { MediaCatalog } from './catalog';
import { MediaImporter, youtubeSource } from './importer';
import { prepareMedia } from './preparation';
import { MediaPreparationStore, PreparationManifest } from './preparation-store';
import { chooseOutputDirectory, inspectYouTube, YouTubePreview } from './preview';
import { exportMediaPackage, PackageCollisionError, PackageExportError } from './export';

export type MediaCommandDependencies = {
 catalog?: MediaCatalog;
 importer?: MediaImporter;
 prepare?: typeof prepareMedia;
 promptUrl?: () => Promise<string|null>;
 chooseDirectory?: typeof chooseOutputDirectory;
 inspect?: typeof inspectYouTube;
 confirm?: (preview:YouTubePreview)=>Promise<boolean>;
 exportPackage?: typeof exportMediaPackage;
 stdout?: (text:string)=>void;
 stderr?: (text:string)=>void;
};

type PreparedSource = {asset:Awaited<ReturnType<MediaCatalog['resolve']>>;manifest:PreparationManifest;segmentCount:number;sheetCount:number};

async function ask(question:string):Promise<string> {
 const prompt=createInterface({input:process.stdin,output:process.stdout});
 try { return await prompt.question(question); }
 finally { prompt.close(); }
}

async function promptUrl():Promise<string|null> {
 const value=(await ask('Pega el enlace público de YouTube (Enter para cancelar): ')).trim();
 return value||null;
}

async function confirmPreview(preview:YouTubePreview):Promise<boolean> {
 const answer=(await ask('¿Descargar y preparar este video? [s/N]: ')).trim().toLowerCase();
 return ['s','si','sí','y','yes'].includes(answer);
}

function previewSummary(preview:YouTubePreview):string[] {
 const duration=preview.duration_seconds===undefined?undefined:`${preview.duration_seconds} s`;
 const size=preview.estimated_bytes===undefined?undefined:`${preview.estimated_bytes} bytes`;
 return [
  `Enlace: ${preview.url}`,
  `ID: ${preview.video_id}`,
  `Título: ${preview.title??'desconocido'}`,
  `Canal: ${preview.uploader??'desconocido'}`,
  `Duración: ${duration??'desconocida'}`,
  `Resolución: ${preview.resolution??'desconocida'}`,
  `Tamaño estimado: ${size??'desconocido'}`,
 ];
}

async function resolveOrImport(
 catalog:MediaCatalog,
 importer:MediaImporter,
 sourceUrl:string,
 errorOut:(text:string)=>void,
 requireReceipt:boolean,
):Promise<Awaited<ReturnType<MediaCatalog['resolve']>>> {
 const existing=catalog.findBySourceUrl(sourceUrl);
 const videoId=new URL(sourceUrl).searchParams.get('v');
 if(existing&&(!requireReceipt||(existing.downloadReceipt?.source_url===sourceUrl&&existing.downloadReceipt.video_id===videoId))) {
  errorOut('source: reusing registered media');
  return catalog.resolve(existing.id);
 }
 if(existing&&requireReceipt) errorOut('source: refreshing media without a verified download receipt');
 let job=importer.start(sourceUrl),lastPhase='';
 while(job.state==='running') {
  if(job.phase!==lastPhase){lastPhase=job.phase;errorOut(`import: ${job.phase}`);}
  job=await importer.status(job.job_id,10);
 }
 if(job.state!=='complete'||!job.asset) throw Error(job.error??'Download or media validation failed');
 const asset=await catalog.resolve(job.asset.id);
 if(asset.sourceUrl!==sourceUrl) throw Error('Imported media source did not match the requested URL');
 if(requireReceipt&&(asset.downloadReceipt?.source_url!==sourceUrl||asset.downloadReceipt.video_id!==videoId)) {
  throw Error('Downloaded video identity could not be verified; no package was exported');
 }
 return asset;
}

async function prepareSource(
 catalog:MediaCatalog,
 asset:Awaited<ReturnType<MediaCatalog['resolve']>>,
 dependencies:MediaCommandDependencies,
 errorOut:(text:string)=>void,
):Promise<PreparedSource> {
 const prepare=dependencies.prepare??prepareMedia;
 let manifest:PreparationManifest;
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
 return {asset,manifest,segmentCount,sheetCount:manifest.artifacts.filter(item=>item.kind==='contact_sheet').length};
}

async function guidedPrepare(
 catalog:MediaCatalog,
 importer:MediaImporter,
 dependencies:MediaCommandDependencies,
 out:(text:string)=>void,
 errorOut:(text:string)=>void,
):Promise<void> {
 const rawUrl=await (dependencies.promptUrl??promptUrl)();
 if(!rawUrl?.trim()) { errorOut('prepare: canceled before URL entry'); return; }
 const outputDirectory=await (dependencies.chooseDirectory??chooseOutputDirectory)();
 if(!outputDirectory) { errorOut('prepare: folder selection canceled'); return; }
 const preview=await (dependencies.inspect??inspectYouTube)(rawUrl.trim());
 for(const line of previewSummary(preview)) out(line);
 if(!await (dependencies.confirm??confirmPreview)(preview)) { errorOut('prepare: canceled before download'); return; }

 const sourceUrl=youtubeSource(rawUrl);
 const asset=await resolveOrImport(catalog,importer,sourceUrl,errorOut,true);
 const prepared=await prepareSource(catalog,asset,dependencies,errorOut);
 let parent=outputDirectory;
 let exported;
 for(let attempt=0;attempt<5;attempt++) {
  try {
   exported=await (dependencies.exportPackage??exportMediaPackage)(catalog,asset,prepared.manifest,new MediaPreparationStore(catalog.home),parent,preview);
   break;
  } catch(error) {
   if(!(error instanceof PackageCollisionError)) {
    if(error instanceof PackageExportError) errorOut(`export: partial package preserved at ${error.partial_directory}`);
    throw error;
   }
   errorOut('export: package name already exists; choose another folder or cancel');
   const replacement=await (dependencies.chooseDirectory??chooseOutputDirectory)();
   if(!replacement) { errorOut('export: canceled; prepared media remains in the private catalog'); return; }
   parent=replacement;
  }
 }
 if(!exported) throw Error('Could not find an unused output folder after five attempts');
 out(JSON.stringify({asset_id:asset.id,status:prepared.manifest.status,duration_seconds:prepared.manifest.duration_seconds??null,
  sheet_count:prepared.sheetCount,segment_count:prepared.segmentCount,package_directory:exported.directory,
  source_sha256:asset.sha256,manifest_sha256:exported.manifest_sha256}));
}

export async function mediaCommand(command:string|undefined,args:string[],dependencies:MediaCommandDependencies={}) {
 const catalog=dependencies.catalog??new MediaCatalog();
 const importer=dependencies.importer??new MediaImporter(catalog);
 const out=dependencies.stdout??((text:string)=>console.log(text));
 const errorOut=dependencies.stderr??((text:string)=>console.error(text));
 if(command==='add' && args.length===1) { const {id,name,bytes,sha256}=await catalog.add(args[0]); out(JSON.stringify({id,name,bytes,sha256},null,2)); }
 else if(command==='list' && !args.length) out(JSON.stringify(catalog.list(),null,2));
 else if(command==='revoke' && args.length===1) {catalog.revoke(args[0]); out('Asset revoked; original preserved.');}
 else if(command==='prepare' && args.length===0) await guidedPrepare(catalog,importer,dependencies,out,errorOut);
 else if(command==='prepare' && args.length===1) {
  const sourceUrl=youtubeSource(args[0]);
  const asset=await resolveOrImport(catalog,importer,sourceUrl,errorOut,false);
  const prepared=await prepareSource(catalog,asset,dependencies,errorOut);
  out(JSON.stringify({asset_id:asset.id,status:prepared.manifest.status,duration_seconds:prepared.manifest.duration_seconds??null,
   sheet_count:prepared.sheetCount,segment_count:prepared.segmentCount}));
 } else throw Error('Usage: isymcp media add <file> | list | revoke <asset_id> | prepare [youtube-url]');
}
