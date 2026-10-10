import {test,expect} from 'bun:test';
import {resolve} from 'node:path';

test('help documents guided preparation and the scriptable URL form',()=>{
 const root=resolve(import.meta.dir,'..');
 const result=Bun.spawnSync([process.execPath,resolve(root,'src/isymcp.ts'),'--help'],{cwd:root,env:{...process.env}});
 expect(result.exitCode).toBe(0);
 const help=result.stdout.toString();
 expect(help).toContain('isymcp media prepare');
 expect(help).toContain('isymcp media prepare <url>');
});
