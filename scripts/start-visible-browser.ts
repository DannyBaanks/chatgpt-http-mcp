#!/usr/bin/env bun
// Local operator entry. New Chrome profile; no authentication import.
import {randomUUID} from 'node:crypto';import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {homedir} from 'node:os';
import {openVisibleBrowser,pageDriver} from '../src/visible/browser-driver';
import {createBrowserWorker} from '../src/visible/browser-worker';
import {readBoundAnswer} from '../src/visible/browser-observer';
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--launch-id'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(args[1])))throw Error('usage: start-visible-browser.ts [--launch-id UUID]');
const launchId=args[1]??randomUUID(),dir=join(homedir(),'.codex-web-http','visible',launchId);mkdirSync(dir,{recursive:true,mode:0o700});
const status={launchId,profileDir:join(dir,'chrome'),state:'browser_starting',url:'https://chatgpt.com/',authenticated:'not_verified'};
const save=()=>writeFileSync(join(dir,'browser-status.json'),JSON.stringify(status,null,2),{mode:0o600});save();
const browser=await openVisibleBrowser({profileDir:status.profileDir,launchId});status.state='waiting_for_user_login';save();console.log(JSON.stringify({launchId,dir,state:status.state,authImported:false,globalConfigChanged:false}));
const worker=await createBrowserWorker({directory:dir,connectorId:'asdk_app_6ace90ad54848191912160b8880294c7',driver:pageDriver(browser.page),readAnswer:source=>readBoundAnswer(browser.page,source)});
const credentialPath=join(dir,`browser-worker-private-${randomUUID()}.json`);
writeFileSync(credentialPath,JSON.stringify({socketPath:worker.socketPath,token:worker.token}),{flag:'wx',mode:0o600});
console.log(JSON.stringify({credentialPath,socketPath:worker.socketPath}));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return Response.json(status);}});console.log(JSON.stringify({statusUrl:`http://127.0.0.1:${server.port}`}));
let stop!:()=>void;const done=new Promise<void>(r=>{stop=r;});process.once('SIGTERM',stop);process.once('SIGINT',stop);
await done;server.stop(true);await worker.close();await browser.close();status.state='stopped';save();
