import {expect,test} from 'bun:test';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createBrowserWorker,browserWorkerRpc} from '../src/visible/browser-worker';
test('owned browser worker refuses foreign tokens and returns actual observations',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'isymcp-browser-worker-'));let reads=0;
 const driver={prepare:async()=>{},send:async()=>{},inspect:async()=>{reads++;return {url:'https://chatgpt.com/c/source',connectorId:'asdk_app_allowed',model:'GPT-6',effort:'medium',messages:[]};}};
 const worker=await createBrowserWorker({directory:dir,connectorId:'asdk_app_allowed',driver,readAnswer:async()=>({url:'https://chatgpt.com/c/source',messages:[]})});
 try{await expect(browserWorkerRpc(worker.socketPath,'foreign',{method:'inspect'})).rejects.toThrow('unauthorized');expect(reads).toBe(0);
 const result=await browserWorkerRpc(worker.socketPath,worker.token,{method:'inspect'});expect(result.model).toBe('GPT-6');expect(reads).toBe(1);
 await expect(browserWorkerRpc(worker.socketPath,worker.token,{method:'execute',command:['touch','anything']})).rejects.toThrow('unsupported');
 }finally{await worker.close();}
});
test('worker observes only acknowledged sources and deduplicates a submission',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'isymcp-worker-source-'));let sends=0,answerReads=0;
 const request={requestId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',connectorId:'asdk_app_allowed',model:'GPT-6',effort:'medium',prompt:'Sólo imprime un marcador.'};
 const messageId='bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 const driver={prepare:async()=>{},send:async()=>{sends++;},inspect:async()=>({url:'https://chatgpt.com/c/source',connectorId:request.connectorId,model:request.model,effort:request.effort,messages:sends?[{messageId,text:'ISYMCP_REQUEST_ID: '+request.requestId}]:[]})};
 const worker=await createBrowserWorker({directory,connectorId:request.connectorId,driver,readAnswer:async source=>{answerReads++;expect(source.messageId).toBe(messageId);return {url:source.url,messages:[]};}});
 try{
  await expect(browserWorkerRpc(worker.socketPath,worker.token,{method:'read_bound_answer',requestId:request.requestId})).rejects.toThrow('source_unbound');expect(answerReads).toBe(0);
  const receipt=await browserWorkerRpc(worker.socketPath,worker.token,{method:'submit',request});
  expect(receipt.userMessageId).toBe(messageId);
  await browserWorkerRpc(worker.socketPath,worker.token,{method:'submit',request});expect(sends).toBe(1);
  await browserWorkerRpc(worker.socketPath,worker.token,{method:'read_bound_answer',requestId:request.requestId});expect(answerReads).toBe(1);
  await expect(browserWorkerRpc(worker.socketPath,worker.token,{method:'submit',request:{...request,connectorId:'foreign'}})).rejects.toThrow('identity_mismatch');expect(sends).toBe(1);
 }finally{await worker.close();}
});
