import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { prepareVisibleProfile } from './browser-driver';

// Authentication precedes Playwright and stays in this exact owned profile.
// Browser exit is only a handoff signal: it never establishes authentication.
export async function manualVisibleLogin(options: {
 profileDir: string; launchId: string; executablePath?: string;
}): Promise<{manualBrowserClosed:true; authenticated:'not_verified'}> {
 prepareVisibleProfile(options);
 const executable = options.executablePath ?? '/usr/bin/google-chrome';
 if (!isAbsolute(executable)) throw Error('visible_manual_login_executable_requires_absolute_path');
 const child = spawn(executable, [
  '--user-data-dir='+options.profileDir, '--new-window',
  '--disable-background-mode', '--no-first-run', '--no-default-browser-check',
  'https://chatgpt.com/',
 ], {env:process.env,stdio:'ignore'});
 await new Promise<void>((resolve,reject)=>{
  child.once('error',()=>reject(Error('visible_manual_login_launch_failed')));
  child.once('exit',(code,signal)=>{
   if(signal)reject(Error('visible_manual_login_interrupted'));
   else if(code!==0)reject(Error('visible_manual_login_exit_'+code));
   else resolve();
  });
 });
 return {manualBrowserClosed:true,authenticated:'not_verified'};
}
