import {spawn,type ChildProcess} from 'node:child_process';
import {readFileSync,lstatSync,existsSync,writeFileSync} from 'node:fs';
import {join,isAbsolute,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {chromium,type Browser} from 'playwright-core';
import {prepareVisibleProfile} from './browser-driver';

export function parseDevtoolsEndpoint(raw:string) {
 const lines=raw.trim().split('\n');
 if(lines.length!==2||!/^\d+$/.test(lines[0])||!/^\/devtools\/browser\/[a-f0-9-]{36}$/i.test(lines[1]))throw Error('visible_host_endpoint_invalid');
 const port=Number(lines[0]);if(!Number.isInteger(port)||port<1||port>65535)throw Error('visible_host_endpoint_invalid');
 return {endpoint:`http://127.0.0.1:${port}`,webSocket:`ws://127.0.0.1:${port}${lines[1]}`};
}
async function stopOwnedProcess(child:ChildProcess) {
 if(child.exitCode!==null||child.signalCode!==null)return;
 // Give Chrome a graceful exit first. Killing the browser process directly
 // leaves its profile marked as crashed and triggers Chrome's restore banner.
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{
   child.kill('SIGTERM');
   const fallback=setTimeout(()=>reject(Error('visible_host_shutdown_timeout')),5000);
   child.once('exit',()=>{clearTimeout(fallback);resolve();});
  },5000);
  child.once('exit',()=>{clearTimeout(timer);resolve();});
 });
}
async function closeOwnedBrowser(browser:Browser,child:ChildProcess) {
 const session=await browser.newBrowserCDPSession();
 try { await session.send('Browser.close'); }
 finally { await session.detach().catch(()=>{}); }
 await stopOwnedProcess(child);
}
export async function selectOwnedHostPage(browser:Pick<Browser,'contexts'>,landing:string,timeoutMs=10000) {
 const deadline=Date.now()+timeoutMs;
 do {
  const pages=browser.contexts().flatMap(context=>context.pages().map(page=>({context,page}))).filter(x=>x.page.url()===landing);
  if(pages.length===1)return pages[0];
  if(pages.length>1)throw Error('visible_host_page_ambiguous');
  await new Promise(r=>setTimeout(r,50));
 }while(Date.now()<deadline);
 throw Error('visible_host_page_unbound');
}

// The launcher owns normal Chrome. Playwright attaches to that exact process
// and page; it does not launch Chrome or supply its default browser switches.
export async function openNormalBrowserHost(options:{profileDir:string;launchId:string;executablePath?:string}) {
 prepareVisibleProfile(options);
 const executable=options.executablePath??'/usr/bin/google-chrome';
 if(!isAbsolute(executable))throw Error('visible_host_executable_invalid');
 const active=join(options.profileDir,'DevToolsActivePort');
 const fingerprint=()=>{
  if(!existsSync(active))return '';
  const stat=lstatSync(active);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())throw Error('visible_host_endpoint_not_owned');
  return stat.mtimeMs+':'+readFileSync(active,'utf8');
 };
 const prior=fingerprint();
 // A real local landing document is retained by normal Chrome at startup;
 // about:blank fragments can be replaced by its configured new-tab surface.
 const landingPath=join(dirname(options.profileDir),'host-landing-'+randomUUID()+'.html');
 writeFileSync(landingPath,'<!doctype html><meta charset="utf-8"><title>ISyMCP browser host</title>',{mode:0o600,flag:'wx'});
 const landing=pathToFileURL(landingPath).href;
 const child=spawn(executable,[
  '--user-data-dir='+options.profileDir,'--new-window','--disable-background-mode',
  '--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled',
  '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',landing,
 ],{env:process.env,stdio:'ignore'});
 let launchFailed=false;child.once('error',()=>{launchFailed=true;});
 let browser:Browser|undefined;
 try {
  const deadline=Date.now()+30000;let address:ReturnType<typeof parseDevtoolsEndpoint>|undefined;
  while(Date.now()<deadline){
   if(launchFailed||child.exitCode!==null||child.signalCode!==null)throw Error('visible_host_process_exited');
   if(fingerprint()&&fingerprint()!==prior){address=parseDevtoolsEndpoint(readFileSync(active,'utf8'));break;}
   await new Promise(r=>setTimeout(r,50));
  }
  if(!address)throw Error('visible_host_start_timeout');
  const response=await fetch(address.endpoint+'/json/version',{signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!response.ok)throw Error('visible_host_metadata_unavailable');
  const metadata=await response.json() as any;
  if(metadata.webSocketDebuggerUrl!==address.webSocket)throw Error('visible_host_endpoint_mismatch');
  browser=await chromium.connectOverCDP(address.endpoint,{timeout:10000,noDefaults:true});
  const ownership=await browser.newBrowserCDPSession();
  try {
   const info=await ownership.send('SystemInfo.getProcessInfo');
   if(!info.processInfo.some(p=>p.type==='browser'&&p.id===child.pid))throw Error('visible_host_process_mismatch');
  } finally {await ownership.detach();}
  const {page,context}=await selectOwnedHostPage(browser,landing);
  await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:60000});
  const connection=browser;
  return {page,context,pid:child.pid!,endpoint:address.endpoint,
   async close(){await closeOwnedBrowser(connection,child);},
  };
 } catch(error){
  const safeUrl=(value:string)=>{try{const u=new URL(value);return u.origin==='null'?u.protocol+'//'+u.host+u.pathname:u.origin+u.pathname;}catch{return 'invalid';}};
  const observation:any={error:error instanceof Error?error.message:'visible_host_failed',pid:child.pid,pages:browser?.contexts().flatMap(c=>c.pages().map(p=>safeUrl(p.url())))??[]};
  if(browser){
   const session=await browser.newBrowserCDPSession().catch(()=>undefined);
   if(session)try{const targets=await session.send('Target.getTargets');observation.targets=targets.targetInfos.map(t=>({type:t.type,url:safeUrl(t.url)}));}finally{await session.detach().catch(()=>{});}
  }
  writeFileSync(join(dirname(options.profileDir),'host-failure-'+randomUUID()+'.json'),JSON.stringify(observation,null,2),{mode:0o600,flag:'wx'});
  if(browser)await closeOwnedBrowser(browser,child).catch(()=>{});
  else await stopOwnedProcess(child).catch(()=>{});
  throw error;
 }
}
