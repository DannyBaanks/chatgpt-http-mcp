import type { ConversationEvent } from './journal';
export type ObservedMessage = Extract<ConversationEvent,{kind:'user'|'assistant'|'progress'}>;
export interface ConversationSnapshot {url:string;messages:ObservedMessage[]}

// Takes rendered observations only. No browser driver, sender, executor or
// connector client is available through this object.
export class PassiveConversationObserver {
 private seen=new Map<string,ObservedMessage>();
 private initialized=false;
 constructor(private url:string){
  const parsed=new URL(url);
  if(parsed.origin!=='https://chatgpt.com'||!/^\/c\/[a-zA-Z0-9-]+$/.test(parsed.pathname)||parsed.search||parsed.hash)throw Error('visible_source_url_invalid');
 }
 private validate(snapshot:ConversationSnapshot){
  if(snapshot.url!==this.url)throw Error('visible_foreign_navigation');
  const keys=new Set<string>();
  for(const message of snapshot.messages){
   if(!['user','assistant','progress'].includes(message.kind)||typeof message.messageId!=='string'||!message.messageId.trim())throw Error(
     'visible_message_identity_missing');
   const key=message.kind+':'+message.messageId;if(keys.has(key))throw Error('visible_message_identity_duplicate');keys.add(key);
   if(message.kind==='assistant'&&(typeof message.markdown!=='string'||typeof message.complete!=='boolean'))throw Error('visible_message_shape_invalid');
   if(message.kind!=='assistant'&&typeof message.text!=='string')throw Error('visible_message_shape_invalid');
   const prior=this.seen.get(key);
   if(prior?.kind==='user'&&message.kind==='user'&&prior.text!==message.text)throw Error('visible_user_message_revised');
   if(prior?.kind==='assistant'&&prior.complete&&message.kind==='assistant'&&message.complete&&message.markdown!==prior.markdown)throw Error(
     'visible_completed_message_revised');
  }
 }
 baseline(snapshot:ConversationSnapshot){
  if(this.initialized)throw Error('visible_baseline_already_set');this.validate(snapshot);
  for(const m of snapshot.messages)this.seen.set(m.kind+':'+m.messageId,structuredClone(m));
  this.initialized=true;
 }
 observe(snapshot:ConversationSnapshot):ObservedMessage[]{
  if(!this.initialized)throw Error('visible_baseline_required');this.validate(snapshot);
  const events:ObservedMessage[]=[];
  for(const m of snapshot.messages){
   const key=m.kind+':'+m.messageId,old=this.seen.get(key);
   if(old?.kind==='assistant'&&old.complete&&m.kind==='assistant'&&!m.complete)continue;
   if(old&&JSON.stringify(old)===JSON.stringify(m))continue;
   this.seen.set(key,structuredClone(m));events.push(structuredClone(m));
  }
  return events;
 }
}

import type {Page} from 'playwright-core';
import {domToMarkdown,type MiniNode} from '../dom-markdown';
export async function readBoundAnswer(page:Page,source:{url:string;messageId:string}):Promise<ConversationSnapshot>{
 if(page.url()!==source.url)throw Error('visible_foreign_navigation');
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(source.messageId))throw Error('visible_message_identity_missing');
 const frame=await page.evaluate(({turnId})=>{
  const roots=Array.from(document.querySelectorAll('[data-turn-key]')).filter(x=>x.getAttribute('data-turn-key')===turnId);
  if(roots.length>1)throw Error('visible_bound_turn_ambiguous');
  const root=roots[0];if(!root)return null;
  const candidates=Array.from(root.querySelectorAll('[data-dil-message-id]'));
  if(candidates.length>1)throw Error('visible_answer_identity_ambiguous');
  const answer=candidates[0];if(!answer)return null;
  const serialize=(n:Node):any=>({nodeType:n.nodeType,tagName:n instanceof Element?n.tagName:undefined,textContent:n.nodeType===3?n.textContent:null,
   attrs:n instanceof Element?Object.fromEntries(['class','href','aria-hidden','data-markdown-copy'].map(k=>[k,n.getAttribute(k)])):undefined,
   className:n instanceof Element?n.className:undefined,childNodes:Array.from(n.childNodes).map(serialize)});
  const hasCopy=Array.from(root.querySelectorAll('button')).some(b=>['Copiar','Copy'].includes(b.getAttribute('aria-label')??''));
  const hasStop=Array.from(document.querySelectorAll('button')).some(b=>['Detener','Stop','Stop generating'].includes(b.getAttribute('aria-label')??''));
  return {messageId:answer.getAttribute('data-dil-message-id'),tree:serialize(answer),complete:hasCopy&&!hasStop};
 },{turnId:source.messageId});
 if(!frame)return {url:source.url,messages:[]};
 if(!frame.messageId)throw Error('visible_message_identity_missing');
 const hydrate=(n:any):MiniNode=>({...n,getAttribute:(key:string)=>n.attrs?.[key]??null,childNodes:n.childNodes.map(hydrate)});
 return {url:source.url,messages:[{kind:'assistant',messageId:frame.messageId,markdown:domToMarkdown(hydrate(frame.tree)),complete:frame.complete}]};
}
