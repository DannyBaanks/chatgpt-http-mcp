import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openNormalBrowserHost,parseDevtoolsEndpoint,selectOwnedHostPage} from '../src/visible/browser-host';
const launchId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
test('normal host refuses foreign profiles without launching Chrome',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'isymcp-host-foreign-'));
 await expect(openNormalBrowserHost({profileDir:directory,launchId})).rejects.toThrow('unowned');
});
test('host waits for its exact new page instead of adopting a restored page',async()=>{
 const landing='about:blank#isymcp-owned';let reads=0;
 const other={url:()=> 'https://chatgpt.com/c/old'};
 const owned={url:()=>landing};
 const context={pages:()=>++reads>1?[other,owned]:[other]};
 const found=await selectOwnedHostPage({contexts:()=>[context]} as any,landing,500);
 expect(found.page).toBe(owned);expect(reads).toBeGreaterThan(1);
 await expect(selectOwnedHostPage({contexts:()=>[{pages:()=>[other]}]} as any,landing,1)).rejects.toThrow('unbound');
});
test('normal host does not adopt another browser when its own process exits',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'isymcp-host-exit-')),log=join(directory,'args'),executable=join(directory,'chrome');
 writeFileSync(executable,'#!/bin/sh\nprintf "%s\\n" "$@" > "'+log+'"\nexit 7\n',{mode:0o700});
 await expect(openNormalBrowserHost({profileDir:join(directory,'profile'),launchId,executablePath:executable})).rejects.toThrow('visible_host_process_exited');
 const args=readFileSync(log,'utf8');expect(args).toContain('--remote-debugging-address=127.0.0.1');expect(args).toContain('--remote-debugging-port=0');
 expect(args).toContain('--disable-blink-features=AutomationControlled');
 expect(args).not.toMatch(/--no-sandbox|--enable-automation|--password-store=basic/);
});
test('devtools metadata pins a loopback endpoint and browser target',()=>{
 const path='/devtools/browser/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 expect(parseDevtoolsEndpoint('43123\n'+path+'\n')).toEqual({endpoint:'http://127.0.0.1:43123',webSocket:'ws://127.0.0.1:43123'+path});
 for(const raw of ['0\n'+path,'65536\n'+path,'43123\nws://foreign/secret','43123\n/devtools/page/other','43123\n'+path+'\nforeign'])expect(()=>parseDevtoolsEndpoint(raw)).toThrow('invalid');
});
