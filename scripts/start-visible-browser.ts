#!/usr/bin/env bun
// Local operator entry. New Chrome profile; no authentication import.
import {randomUUID} from 'node:crypto';import {mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';import {join} from 'node:path';import {homedir} from 'node:os';
import {openVisibleBrowser,pageDriver} from '../src/visible/browser-driver';
import {createBrowserWorker} from '../src/visible/browser-worker';
import {readBoundAnswer} from '../src/visible/browser-observer';
import {manualVisibleLogin} from '../src/visible/browser-login';
const args=process.argv.slice(2);
const rest=args.filter(a=>a!=='--login');
if(args.filter(a=>a==='--login').length>1||(rest.length&&!(rest.length===2&&rest[0]==='--launch-id'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(rest[1]))))throw Error('usage: start-visible-browser.ts [--launch-id UUID] [--login]');
const launchId=rest[1]??randomUUID(),dir=join(homedir(),'.codex-web-http','visible',launchId);mkdirSync(dir,{recursive:true,mode:0o700});
const status={launchId,profileDir:join(dir,'chrome'),state:'browser_starting',url:'https://chatgpt.com/',authenticated:'not_verified'};
const save=()=>writeFileSync(join(dir,'browser-status.json'),JSON.stringify(status,null,2),{mode:0o600});save();
if(args.includes('--login')||!rest.length){
 status.state='waiting_for_manual_login';save();
 console.log(JSON.stringify({launchId,dir,state:status.state,authImported:false,instruction:'Inicia sesión en esta ventana de Chrome normal. Cuando ChatGPT esté listo, cierra únicamente esa ventana; después se abrirá el controlador.'}));
 await manualVisibleLogin({profileDir:status.profileDir,launchId});
 status.state='browser_starting';save();
}
const browser=await openVisibleBrowser({profileDir:status.profileDir,launchId});status.state='browser_ready_auth_unverified';save();console.log(JSON.stringify({launchId,dir,state:status.state,authImported:false,globalConfigChanged:false}));
const sockPath=join(dir,'browser.sock');if(existsSync(sockPath))rmSync(sockPath,{force:true});
const worker=await createBrowserWorker({directory:dir,connectorId:'asdk_app_6ace90ad54848191912160b8880294c7',driver:pageDriver(browser.page),readAnswer:source=>readBoundAnswer(browser.page,source)});
const credentialPath=join(dir,`browser-worker-private-${randomUUID()}.json`);
writeFileSync(credentialPath,JSON.stringify({socketPath:worker.socketPath,token:worker.token}),{flag:'wx',mode:0o600});
console.log(JSON.stringify({credentialPath,socketPath:worker.socketPath}));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return Response.json(status);}});console.log(JSON.stringify({statusUrl:`http://127.0.0.1:${server.port}`}));
let stop!:()=>void;const done=new Promise<void>(r=>{stop=r;});process.once('SIGTERM',stop);process.once('SIGINT',stop);browser.page.once('close',stop);
await done;server.stop(true);await worker.close();if(existsSync(sockPath))rmSync(sockPath,{force:true});await browser.close();status.state='stopped';save();
