import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run} from '../src/media/process';
import {contactSheet,sampleTimes} from '../src/media/contact-sheet';
test('sheet sampling is chronological, bounded and excludes interval endpoint',()=>{
 const times=sampleTimes(10,26,16,30);expect(times).toHaveLength(16);expect(times[0]).toBe(10);expect(times[15]).toBe(25);
 expect(()=>sampleTimes(0,61,16,90)).toThrow();expect(()=>sampleTimes(0,10,1000,30)).toThrow();
});
test('real sheet has 1920x1080 pixels and 16 ordered red/blue cells',async()=>{
 const root=mkdtempSync(join(tmpdir(),'isymcp-sheet-'));const path=join(root,'transition.mp4');
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=128x72:r=8:d=1','-f','lavfi','-i','color=blue:s=128x72:r=8:d=1','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','mpeg4',path]);
 const sheet=await contactSheet(path,0,2,4);expect(sheet.metadata.samples).toHaveLength(16);
 const image=join(root,'sheet.jpg');writeFileSync(image,Buffer.from(sheet.image.data,'base64'));
 const rgb=await run('ffmpeg',['-v','error','-i',image,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],1920*1080*3);
 expect(rgb.length).toBe(1920*1080*3);
 for(let i=0;i<16;i++) {const x=(i%4)*480+240,y=Math.floor(i/4)*270+100,at=(y*1920+x)*3;
  if(i<8)expect(rgb[at]).toBeGreaterThan(rgb[at+2]+100);else expect(rgb[at+2]).toBeGreaterThan(rgb[at]+100);
 }
 expect(Buffer.from(sheet.image.data,'base64').length).toBeLessThanOrEqual(1024*1024);
},30000);
