import {expect,test} from 'bun:test';
import {ObservedResponseProjector} from '../src/visible/responses';
test('observed updates become real deltas before completion and preserve Unicode Markdown',()=>{
 const p=new ObservedResponseProjector('verified-web');
 expect(p.initial().map(e=>e.type)).toEqual(['response.created','response.in_progress','response.output_item.added','response.content_part.added']);
 const one=p.push({kind:'assistant',messageId:'one',markdown:'Hola 😄',complete:false});
 const two=p.push({kind:'assistant',messageId:'one',markdown:'Hola 😄\n```json\n{"kind":"call"}\n```',complete:false});
 expect(one.filter(e=>e.type==='response.output_text.delta')).toHaveLength(1);expect(two.filter(e=>e.type==='response.output_text.delta')).toHaveLength(1);
 expect([...one,...two].some(e=>e.type==='response.completed')).toBe(false);
 const done=p.push({kind:'assistant',messageId:'one',markdown:'Hola 😄\n```json\n{"kind":"call"}\n```',complete:true});
 expect(done.at(-1).response.output_text).toBe(one[0].delta+two[0].delta);expect(done.at(-1).response.usage).toBeNull();
 expect(done.some(e=>/tool_call/.test(e.type))).toBe(false);
});
test('remounts do not duplicate deltas, changed prefix fails, foreign message fails',()=>{
 const p=new ObservedResponseProjector('verified-web');p.initial();p.push({kind:'assistant',messageId:'one',markdown:'abc',complete:false});
 expect(p.push({kind:'assistant',messageId:'one',markdown:'abc',complete:false})).toEqual([]);
 expect(()=>p.push({kind:'assistant',messageId:'two',markdown:'abcd',complete:false})).toThrow('identity');
 expect(()=>p.push({kind:'assistant',messageId:'one',markdown:'axc',complete:false})).toThrow('conflict');
});
test('closed browser never projects a completed answer and event sequence is monotonic',()=>{
 const p=new ObservedResponseProjector('verified-web');const first=p.initial();const partial=p.push({kind:'assistant',messageId:'one',markdown:'partial',complete:false});
 const fail=p.push({kind:'closed',reason:'browser_exit'});expect(fail[0].type).toBe('response.failed');expect(fail[0].response.error.code).toBe('visible_browser_closed');
 expect([...first,...partial,...fail].map(e=>e.sequence_number)).toEqual([0,1,2,3,4,5]);
 expect(()=>p.push({kind:'assistant',messageId:'one',markdown:'partial',complete:true})).toThrow('terminal');
});
