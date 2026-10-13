import {createHash} from 'node:crypto';
import {writeFileSync,readFileSync,existsSync,lstatSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
export interface SubmissionRequest {requestId:string;prompt:string;connectorId:string;model:string;effort:string}
export interface DriverObservation {url:string;connectorId:string;model:string;effort:string;messages:{messageId:string;text:string}[]}
export interface BrowserDriverPort {prepare(text:string,connectorId:string):Promise<void>;inspect():Promise<DriverObservation>;send():Promise<void>}
export interface SubmissionReceipt {url:string;userMessageId:string;requestId:string}
const inflight=new Map<string,{signature:string;promise:Promise<SubmissionReceipt>}>();
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function privateFile(path:string){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077))throw Error('visible_submission_file_not_private');return JSON.parse(readFileSync(path,'utf8'));}
export function submitOnce(directory:string,port:BrowserDriverPort,request:SubmissionRequest):Promise<SubmissionReceipt>{
 if(!isAbsolute(directory)||!uuid.test(request.requestId)||!request.prompt.trim()||!request.connectorId.trim()||!request.model.trim()||!request.effort.trim())return Promise.reject(Error('visible_submission_invalid'));
 const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077))return Promise.reject(Error('visible_submission_home_not_private'));
 const key=join(directory,request.requestId),signature=hash(JSON.stringify(request)),prior=inflight.get(key);
 if(prior)return prior.signature===signature?prior.promise:Promise.reject(Error('visible_submission_arguments_changed'));
 const promise=(async()=>{
  const prepared=key+'.prepared.json',attempted=key+'.attempted.json',observed=key+'.observed.json';
  if(existsSync(prepared)&&privateFile(prepared).signature!==signature)throw Error('visible_submission_arguments_changed');
  if(existsSync(observed))return privateFile(observed).receipt;
  const marker='ISYMCP_REQUEST_ID: '+request.requestId;
  const reconcile=(state:DriverObservation):SubmissionReceipt|undefined=>{
   const url=new URL(state.url);if(url.origin!=='https://chatgpt.com'||!/^\/c\/[a-zA-Z0-9-]+$/.test(url.pathname)||url.search||url.hash)return;
   const matches=state.messages.filter(m=>uuid.test(m.messageId)&&m.text.includes(marker));
   if(matches.length!==1)return;
   const receipt={url:state.url,userMessageId:matches[0].messageId,requestId:request.requestId};
   writeFileSync(observed,JSON.stringify({signature,receipt}),{mode:0o600,flag:'wx'});return receipt;
  };
  if(existsSync(attempted)){
   const ack=reconcile(await port.inspect());if(ack)return ack;
   throw Error('visible_submit_ambiguous_no_resubmission');
  }
  await port.prepare(marker+'\n'+request.prompt,request.connectorId);
  const state=await port.inspect();
  if(state.connectorId!==request.connectorId)throw Error('visible_connector_identity_mismatch');
  if(state.model!==request.model||state.effort!==request.effort)throw Error('visible_model_selection_mismatch');
  if(!existsSync(prepared))writeFileSync(prepared,JSON.stringify({signature,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
  try{writeFileSync(attempted,JSON.stringify({signature,at:new Date().toISOString()}),{flag:'wx',mode:0o600});}
  catch{throw Error('visible_submit_ambiguous_no_resubmission');}
  try{await port.send();const ack=reconcile(await port.inspect());if(ack)return ack;}
  catch{}
  throw Error('visible_submit_ambiguous_no_resubmission');
 })();inflight.set(key,{signature,promise});void promise.finally(()=>inflight.delete(key)).catch(()=>{});return promise;
}

import {chromium,type Page,type BrowserContext} from 'playwright-core';
import {mkdirSync,chmodSync} from 'node:fs';
export async function openVisibleBrowser(options:{profileDir:string;launchId:string}):Promise<{page:Page;context:BrowserContext;close():Promise<void>}>{
 if(!isAbsolute(options.profileDir)||!uuid.test(options.launchId))throw Error('visible_profile_invalid');
 const existed=existsSync(options.profileDir);
 if(!existed)mkdirSync(options.profileDir,{recursive:true,mode:0o700});
 const stat=lstatSync(options.profileDir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())throw Error('visible_profile_not_owned');
 const marker=join(options.profileDir,'isymcp-visible-profile.json');
 if(existed&&!existsSync(marker))throw Error('visible_profile_unowned');
 if(existsSync(marker)){if(privateFile(marker).launchId!==options.launchId)throw Error('visible_profile_owner_mismatch');}
 else writeFileSync(marker,JSON.stringify({version:'isymcp-visible-profile/1',launchId:options.launchId}),{mode:0o600,flag:'wx'});
 chmodSync(options.profileDir,0o700);
 // New owned persistent profile; never storageState, imported cookies, or a
 // remotely exposed debugging port. Authentication belongs to this profile.
 const context=await chromium.launchPersistentContext(options.profileDir,{channel:'chrome',headless:false,locale:'es-MX'});
 const page=context.pages()[0]??await context.newPage();await page.goto('https://chatgpt.com/');
 return {page,context,close:()=>context.close()};
}
export function pageDriver(page:Page):BrowserDriverPort {
 const box=()=>page.getByRole('textbox',{name:/Pregunta a ChatGPT|Ask ChatGPT/});
 const chooser=()=>page.getByRole('button',{name:/Seleccionar modelo de ChatGPT|Select ChatGPT model/});
 return {
  async prepare(text,connectorId){
   if(!await box().isVisible())throw Error('visible_login_required');
   await box().fill('@Codex ISyMCP');
   const candidate=page.getByRole('button',{name:'Codex ISyMCP Codex ISyMCP',exact:true});
   await candidate.waitFor({state:'visible',timeout:5000});if(await candidate.count()!==1)throw Error('visible_connector_ambiguous');
   await candidate.click();
   if(await box().locator('[app-mention-path]').getAttribute('app-mention-path')!=='app://'+connectorId)throw Error('visible_connector_identity_mismatch');
   await box().press('End');await box().pressSequentially(' '+text);
  },
  async inspect(){
   const connector=await box().locator('[app-mention-path]').getAttribute('app-mention-path');
   const effortLabel=(await chooser().innerText()).trim();
   const effort=({Media:'medium',Medium:'medium',Alta:'high',High:'high',Baja:'low',Low:'low'} as Record<string,string>)[effortLabel]??'unknown';
   await chooser().click();
   let model:string;
   try{model=(await page.locator('[role="menuitemradio"][aria-checked="true"]').innerText()).trim();}
   finally{await page.getByRole('menu',{name:/Seleccionar modelo de ChatGPT|Select ChatGPT model/}).press('Escape');}
   const messages=await page.evaluate(()=>Array.from(document.querySelectorAll('[data-turn-key]')).map(el=>({messageId:el.getAttribute('data-turn-key')??'',text:el.textContent??''})));
   return {url:page.url(),connectorId:connector?.replace(/^app:\/\//,'')??'',model,effort,messages};
  },
  async send(){await page.getByRole('button',{name:/^(Enviar|Send)$/}).click();await page.waitForURL(/https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+/,{timeout:10000});},
 };
}
