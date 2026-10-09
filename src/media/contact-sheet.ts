import {run} from './process';
import {probe,windowRange} from './audio';
export function sampleTimes(start:number,end:number,count:number,duration:number) {
 windowRange(start,end,duration);
 if(![9,16,36].includes(count))throw Error('Contact sheet requires 9, 16 or 36 frames');
 return Array.from({length:count},(_,i)=>start+(end-start)*i/count);
}
export async function contactSheet(path:string,start:number,end:number,columns=4) {
 if(![3,4,6].includes(columns))throw Error('Contact sheet columns must be 3, 4 or 6');
 const info=await probe(path);if(!info.streams.some(s=>s.codec_type==='video'))throw Error('Media has no video stream');
 const times=sampleTimes(start,end,columns*columns,info.duration_seconds);
 const width=1920/columns,height=1080/columns,band=24;
 const canvas=Buffer.alloc(1920*1080*3);const samples=[];
 for(let index=0;index<times.length;index++) {
  const t=times[index],label=`${String(index+1).padStart(2,'0')}  t=${t.toFixed(3)}s`;
  const filter=`scale=${width}:${height-band}:force_original_aspect_ratio=decrease,pad=${width}:${height-band}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,pad=${width}:${height}:0:0:black,drawtext=text='${label}':fontsize=16:fontcolor=white:x=8:y=${height-band+3}`;
  const cell=await run('ffmpeg',['-v','error','-nostdin','-protocol_whitelist','file,pipe','-ss',String(t),'-i',path,'-map','0:v:0','-an','-vf',filter,'-frames:v','1','-threads','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],width*height*3);
  if(cell.length!==width*height*3)throw Error('Requested frame could not be decoded; no sheet returned');
  const column=index%columns,row=Math.floor(index/columns);
  for(let y=0;y<height;y++)cell.copy(canvas,((row*height+y)*1920+column*width)*3,y*width*3,(y+1)*width*3);
  samples.push({frame:index+1,row:row+1,column:column+1,timestamp_seconds:t});
 }
 for(const quality of [4,8,12]) {
  try {
   const jpg=await run('ffmpeg',['-v','error','-nostdin','-f','rawvideo','-pixel_format','rgb24','-video_size','1920x1080','-i','pipe:0','-frames:v','1','-threads','1','-c:v','mjpeg','-q:v',String(quality),'-pix_fmt','yuvj420p','-f','image2pipe','pipe:1'],1024*1024,60000,{input:canvas});
   if(!jpg.subarray(0,3).equals(Buffer.from([255,216,255])))throw Error('Invalid contact sheet JPEG');
   return {metadata:{width:1920,height:1080,columns,rows:columns,cell_width:width,cell_height:height,jpeg_quality:quality,order:'left-to-right then top-to-bottom',samples,limitations:'Timestamps are requested seek times; decoded frames may differ by frame timing. Sheet is a sampled overview, not animation. Ask video_frame for detail.'},image:{type:'image' as const,mimeType:'image/jpeg',data:jpg.toString('base64')}};
  }catch(error){if(!(error instanceof Error)||!error.message.includes('exceeds limit'))throw error;}
 }
 throw Error('Contact sheet exceeds image limit; request fewer columns');
}
