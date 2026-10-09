import {test,expect} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run} from '../src/media/process';
import {MediaCatalog} from '../src/media/catalog';
import {MediaService} from '../src/media/service';
const entry=process.env.ISYMCP_VIDEO_VISION_ENTRY;
(entry?test:test.skip)('installed Video Vision returns a real local frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-video-'));const file=join(root,'video.mp4');
 await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=128x128:rate=2:duration=2','-c:v','mpeg4',file]);
 const c=new MediaCatalog(join(root,'state'));const a=await c.add(file);const service=new MediaService(c);
 const result=await service.call('video_frame',{asset_id:a.id,timestamp_seconds:0.5});
 expect(result.isError).not.toBe(true);expect(result.content[1].type).toBe('image');
 const audio=await service.call('audio_analyze',{asset_id:a.id,start_seconds:0,end_seconds:1});expect(audio.isError).toBe(true);expect(audio.content[0].text).toContain('no audio');
},65000);
