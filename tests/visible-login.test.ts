import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualVisibleLogin } from '../src/visible/browser-login';

const launchId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function fixture(code: number) {
 const dir = mkdtempSync(join(tmpdir(), 'isymcp-manual-login-'));
 const executable = join(dir, 'fixture-browser');
 const log = join(dir, 'arguments.txt');
 writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "'+log+'"\nexit '+code+'\n', {mode: 0o700});
 return {dir, executable, log, profileDir: join(dir, 'chrome')};
}
test('manual login launches normal Chrome only and closing is not an authentication claim', async () => {
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
test('failed manual browser never reports readiness', async () => {
 const f = fixture(7);
 await expect(manualVisibleLogin({profileDir:f.profileDir,launchId,executablePath:f.executable})).rejects.toThrow('manual_login_exit_7');
});
test('manual login refuses an existing foreign profile without starting a browser', async () => {
 const f = fixture(0);
 await expect(manualVisibleLogin({profileDir:f.dir,launchId,executablePath:f.executable})).rejects.toThrow('unowned');
 expect(existsSync(f.log)).toBe(false);
});
