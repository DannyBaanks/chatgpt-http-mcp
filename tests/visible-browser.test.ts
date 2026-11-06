import { test,expect } from 'bun:test';
import { PassiveConversationObserver } from '../src/visible/browser-observer';
const url='https://chatgpt.com/c/6ace8d1f-4448-83e8-a2bc-40f1dd92415a';
const snapshot=(messages:any[])=>({url,messages});
test('historical baseline and remount do not invent turns; equal new messages remain distinct',()=>{
 const o=new PassiveConversationObserver(url);o.baseline(snapshot([{kind:'user',messageId:'old',text:'same'}]));
 expect(o.observe(snapshot([{kind:'user',messageId:'old',text:'same'}]))).toEqual([]);
 expect(o.observe(snapshot([{kind:'user',messageId:'one',text:'same'},{kind:'user',messageId:'two',text:'same'}])).map(e=>e.messageId)).toEqual(['one','two']);
 expect(o.observe(snapshot([{kind:'user',messageId:'one',text:'same'}]))).toEqual([]);
});
test('assistant changes are snapshots, code fences stay text and completion is observed',()=>{
 const o=new PassiveConversationObserver(url);o.baseline(snapshot([]));
 const msg={kind:'assistant' as const,messageId:'a',markdown:'```json\n{"kind":"call"}\n```',complete:false};
 expect(o.observe(snapshot([msg]))).toEqual([msg]);expect(o.observe(snapshot([msg]))).toEqual([]);
 expect(o.observe(snapshot([{...msg,complete:true}]))).toEqual([{...msg,complete:true}]);
 expect(o.observe(snapshot([msg]))).toEqual([]); // a stale remount must not reopen a completed message
 expect('send' in o).toBe(false);expect('execute' in o).toBe(false);
});
test('missing identity and foreign navigation fail before any event is accepted',()=>{
 const o=new PassiveConversationObserver(url);o.baseline(snapshot([]));
 expect(()=>o.observe(snapshot([{kind:'user',messageId:'',text:'hello'}]))).toThrow('identity');
 expect(()=>o.observe({url:'https://chatgpt.com/c/foreign',messages:[]})).toThrow('navigation');
 expect(o.observe(snapshot([{kind:'user',messageId:'one',text:'hello'}]))).toHaveLength(1);
});
test('one logical user message cannot silently change its content',()=>{
 const o=new PassiveConversationObserver(url);o.baseline(snapshot([]));o.observe(snapshot([{kind:'user',messageId:'one',text:'hello'}]));
 expect(()=>o.observe(snapshot([{kind:'user',messageId:'one',text:'changed'}]))).toThrow('revised');
});
