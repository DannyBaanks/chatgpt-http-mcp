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
function renderHostLandingHtml(options: { launchId: string; profileDir: string }): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ISyMCP — Browser Host</title>
  <style>
    :root{--bg:#090b0a;--panel:#101412;--line:#1d2420;--ink:#d9e4dc;--mute:#6f8076;--ok:#7cff9b;--warn:#ffcc66;--mono:"JetBrains Mono","Fira Code",ui-monospace,Menlo,monospace;--sans:Inter,"Segoe UI",system-ui,sans-serif}
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans);display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;background-image:linear-gradient(rgba(124,255,155,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(124,255,155,.03) 1px,transparent 1px);background-size:28px 28px}
    .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;max-width:580px;width:100%;padding:28px 32px;box-shadow:0 16px 40px rgba(0,0,0,.6);position:relative;overflow:hidden}
    .card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--ok)}
    .header{display:flex;align-items:center;gap:12px;margin-bottom:20px}
    .pulse{width:10px;height:10px;border-radius:50%;background:var(--ok);box-shadow:0 0 12px var(--ok);animation:pulse 2s infinite}
    @keyframes pulse{50%{opacity:.35}}
    h1{font:700 20px/1.2 var(--mono);color:var(--ok);letter-spacing:.08em}
    .sub{color:var(--mute);font:12px var(--mono);margin-top:2px}
    .grid{display:grid;gap:10px;margin:18px 0;background:#0b0f0d;border:1px solid var(--line);border-radius:10px;padding:14px 16px;font:12px var(--mono)}
    .row{display:flex;justify-content:space-between;gap:12px}
    .lbl{color:var(--mute)}
    .val{color:var(--ink);text-align:right;word-break:break-all}
    .val.ok{color:var(--ok)}
    .badge{display:inline-block;padding:2px 8px;border-radius:6px;font:600 11px var(--mono);background:color-mix(in srgb,var(--ok) 15%,transparent);border:1px solid color-mix(in srgb,var(--ok) 35%,transparent);color:var(--ok)}
    .notice{border-left:3px solid var(--warn);padding:8px 12px;background:color-mix(in srgb,var(--warn) 8%,transparent);border-radius:0 8px 8px 0;font:12px var(--sans);color:#e5ded0;margin-top:18px}
    .footer{margin-top:20px;text-align:center;font:11px var(--mono);color:var(--mute)}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="pulse"></div>
      <div>
        <h1>ISyMCP BROWSER HOST</h1>
        <div class="sub">Visible Chrome · Loopback CDP Controller</div>
      </div>
    </div>
    <p style="color:#b2c2b7;font-size:13px;">Host normal de Google Chrome conectado mediante CDP en loopback local. Preparando sesión interactiva...</p>
    <div class="grid">
      <div class="row"><span class="lbl">Launch ID:</span><span class="val">${options.launchId}</span></div>
      <div class="row"><span class="lbl">CDP Loopback:</span><span class="val ok">127.0.0.1 (Dynamic Port)</span></div>
      <div class="row"><span class="lbl">Perfil Aislado:</span><span class="val">${options.profileDir}</span></div>
      <div class="row"><span class="lbl">Conector MCP:</span><span class="val"><span class="badge">@Codex ISyMCP</span></span></div>
      <div class="row"><span class="lbl">Destino:</span><span class="val ok">https://chatgpt.com/</span></div>
    </div>
    <div class="notice">
      <b>Modo Seguro Activo (Compliance P0):</b> Utiliza esta ventana a mano con tu sesión. Los comandos solicitados por ChatGPT se ejecutan en tu máquina bajo sandbox local (<code>bwrap-read-only</code>). La automatización desatendida de la interfaz de usuario está deshabilitada para proteger tu cuenta de OpenAI.
    </div>
    <div class="footer">
      ISyMCP · Protocolo de Aislamiento de Procesos Locales · Loopback Only
    </div>
  </div>
</body>
</html>`;
}

 // A real local landing document is retained by normal Chrome at startup;
 // about:blank fragments can be replaced by its configured new-tab surface.
 const landingPath=join(dirname(options.profileDir),'host-landing-'+randomUUID()+'.html');
 writeFileSync(landingPath,renderHostLandingHtml(options),{mode:0o600,flag:'wx'});
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
