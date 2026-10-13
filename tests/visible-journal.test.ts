import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationJournal } from '../src/visible/journal';
const owner = {launchId:'01a12f10-6159-7791-b7fb-9744b683a7c8',threadId:'01a12f10-6159-7791-b7fb-9744b683a7c8',turnId:'01a136f2-f8b1-7e23-bd79-007654c0f91c',epoch:'01a136f2-f8b1-7e23-bd79-007654c0f91d'};
const path = () => join(mkdtempSync(join(tmpdir(),'isymcp-journal-')),'events.jsonl');
test('journal preserves exact Markdown and monotonic sequences after reopening', async()=>{
 const file=path(); const j=new ConversationJournal(file,owner);
 const text='hola 😄\n```json\n{"kind":"call"}\n```';
 await j.append({kind:'assistant',messageId:'message-1',markdown:text,complete:false});
 const k=new ConversationJournal(file,owner); const next=await k.append({kind:'assistant',messageId:'message-1',markdown:text+'\nfin',complete:true});
 expect(next.sequence).toBe(2); expect(k.readAfter(0).map(r=>r.event.markdown)).toEqual([text,text+'\nfin']);
 expect(statSync(file).mode&0o777).toBe(0o600);
 expect(k.readAfter(1)).toHaveLength(1);
});
test('journal rejects a foreign owner or corrupt tail without rewriting evidence', async()=>{
 const file=path(); await new ConversationJournal(file,owner).append({kind:'user',messageId:'one',text:'same'});
 const before=readFileSync(file,'utf8'); expect(()=>new ConversationJournal(file,{...owner,epoch:owner.threadId})).toThrow('owner');
 expect(readFileSync(file,'utf8')).toBe(before); appendFileSync(file,'{"partial":');
 const corrupt=readFileSync(file,'utf8');expect(()=>new ConversationJournal(file,owner)).toThrow('corrupt'); expect(readFileSync(file,'utf8')).toBe(corrupt);
});
test('equal prompts with distinct message IDs are retained as distinct events',async()=>{
 const j=new ConversationJournal(path(),owner); await j.append({kind:'user',messageId:'one',text:'hola'});await j.append({kind:'user',messageId:'two',text:'hola'});
 expect(j.readAfter(0).map(e=>e.event.messageId)).toEqual(['one','two']);
});
test('a second stale writer refuses to append instead of reusing a sequence',async()=>{
 const file=path();const a=new ConversationJournal(file,owner),b=new ConversationJournal(file,owner);
 await a.append({kind:'user',messageId:'one',text:'hello'});
 await expect(b.append({kind:'user',messageId:'two',text:'hello'})).rejects.toThrow('writer');
 expect(new ConversationJournal(file,owner).readAfter(0)).toHaveLength(1);
});
