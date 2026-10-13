import {expect,test} from 'bun:test';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {submitOnce} from '../src/visible/browser-driver';
const req={requestId:'01a136f2-f8b1-7e23-bd79-007654c0f91c',prompt:'Hola',connectorId:'asdk_app_verified',model:'GPT-6',effort:'Medium'};
const setup=()=>{let sends=0;let messages:any[]=[];const port={prepare:async()=>{},inspect:async()=>({url:'https://chatgpt.com/c/verified',connectorId:req.connectorId,model:req.model,effort:req.effort,messages}),send:async()=>{sends++;messages=[{messageId:'451d9bda-c079-4842-a23b-255feb1a57ab',text:'ISYMCP_REQUEST_ID: '+req.requestId+'\nHola'}];}};return {dir:mkdtempSync(join(tmpdir(),'isymcp-submit-')),port,count:()=>sends};};
test('exact connector and model precede one send; repeated request observes the same message',async()=>{const s=setup();const a=await submitOnce(s.dir,s.port,req);const b=await submitOnce(s.dir,s.port,req);expect(a).toEqual(b);expect(s.count()).toBe(1);});
test('wrong connector with the same display name or wrong model refuses transmission',async()=>{const s=setup();const read=s.port.inspect;s.port.inspect=async()=>({...await read(),connectorId:'asdk_app_wrong'});await expect(submitOnce(s.dir,s.port,req)).rejects.toThrow('connector');expect(s.count()).toBe(0);s.port.inspect=async()=>({...await read(),model:'other'});await expect(submitOnce(s.dir,s.port,req)).rejects.toThrow('model');expect(s.count()).toBe(0);});
test('lost acknowledgement never resends after restart; changed arguments reject',async()=>{const s=setup();s.port.send=async()=>{throw Error('network lost')};await expect(submitOnce(s.dir,s.port,req)).rejects.toThrow('ambiguous');let retries=0;s.port.send=async()=>{retries++};await expect(submitOnce(s.dir,s.port,req)).rejects.toThrow('ambiguous');expect(retries).toBe(0);await expect(submitOnce(s.dir,s.port,{...req,prompt:'changed'})).rejects.toThrow('changed');});

test('opening a visible browser refuses an existing unowned profile before touching its files',async()=>{
 const {openVisibleBrowser}=await import('../src/visible/browser-driver');
 const {writeFileSync,readdirSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'isymcp-foreign-profile-'));
 writeFileSync(join(dir,'user-data.txt'),'preserve');
 await expect(openVisibleBrowser({profileDir:dir,launchId:req.requestId})).rejects.toThrow('unowned');
 expect(readdirSync(dir)).toEqual(['user-data.txt']);
});
