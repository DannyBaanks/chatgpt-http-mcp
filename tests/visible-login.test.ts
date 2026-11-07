import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualVisibleLogin } from '../src/visible/browser-login';

const launchId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
// Motivo del skip en Windows de los dos que lanzan el navegador falso: el producto usa
// spawn de node:child_process (src/visible/browser-login.ts:1,15), que rechaza .cmd/.bat
// por la mitigacion CVE-2024-27980, y un .exe falso exigiria compilar en cada corrida.
// La proteccion de perfil sigue cubierta aqui por el test que no llega a lanzar nada.
const launchTest = test.skipIf(process.platform === "win32");
function fixture(code: number) {
 const dir = mkdtempSync(join(tmpdir(), 'isymcp-manual-login-'));
 const executable = join(dir, 'fixture-browser');
 const log = join(dir, 'arguments.txt');
 writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "'+log+'"\nexit '+code+'\n', {mode: 0o700});
 return {dir, executable, log, profileDir: join(dir, 'chrome')};
}
launchTest('manual login launches normal Chrome only and closing is not an authentication claim', async () => {
 const f = fixture(0);
 const result = await manualVisibleLogin({profileDir:f.profileDir,launchId,executablePath:f.executable});
 const args = readFileSync(f.log, 'utf8').trim().split('\n');
 expect(args).toContain('--user-data-dir='+f.profileDir);
 expect(args).toContain('--disable-background-mode');
 expect(args).toContain('https://chatgpt.com/');
 expect(args.some(a=>/remote-debugging|enable-automation|password-store|mock-keychain|no-sandbox/.test(a))).toBe(false);
 expect(result).toEqual({manualBrowserClosed:true,authenticated:'not_verified'});
 expect(existsSync(join(f.profileDir,'isymcp-visible-profile.json'))).toBe(true);
});
launchTest('failed manual browser never reports readiness', async () => {
 const f = fixture(7);
 await expect(manualVisibleLogin({profileDir:f.profileDir,launchId,executablePath:f.executable})).rejects.toThrow('manual_login_exit_7');
});
test('manual login refuses an existing foreign profile without starting a browser', async () => {
 const f = fixture(0);
 await expect(manualVisibleLogin({profileDir:f.dir,launchId,executablePath:f.executable})).rejects.toThrow('unowned');
 expect(existsSync(f.log)).toBe(false);
});
