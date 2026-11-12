// src/media/cookie-login.ts — `isymcp media login <sitio>`: mismo flujo de dos fases que scripts/login.ts
// (la sesión de ChatGPT), con un perfil de Chrome DEDICADO a media:
//   Fase 1 — Chrome NORMAL (sin automatización) en la página de login del sitio; el operador inicia sesión
//            y cierra la ventana.
//   Fase 2 — Playwright abre ese perfil en headless solo para leer las cookies, se filtran a los dominios
//            del sitio y se guardan en cookies.txt (0600). No se imprime ningún valor.
import { chromium, type BrowserContext } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeHome } from '../codex-sessions';
import { defaultBrowserExecutable } from '../platform/browser';
import { securePrivatePath } from '../platform/private-path';
import { saveSiteCookies, toNetscape, type BrowserCookie, type CookieSite } from './cookies';

export function mediaProfileDir(env: Record<string, string | undefined> = process.env): string {
  return join(bridgeHome(env), 'media-chrome-profile');
}

export async function captureSiteCookies(
  site: CookieSite,
  opts: { exportOnly?: boolean; out?: (s: string) => void } = {},
): Promise<number> {
  const out = opts.out ?? ((s: string) => console.log(s));
  const chrome = process.env.CHROME_PATH ?? defaultBrowserExecutable();
  const profile = mediaProfileDir();
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  securePrivatePath(profile, true);

  if (!opts.exportOnly) {
    out(`FASE 1 — Chrome normal con el perfil de media (${profile}).`);
    out(`Inicia sesión en ${site.label} y luego CIERRA esa ventana de Chrome por completo.`);
    const proc = Bun.spawn([chrome, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', site.loginUrl],
      { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    const code = await proc.exited;
    if (code !== 0) throw Error(`Chrome salió con código ${code}; cierra las ventanas que queden y reintenta (o usa --export).`);
    out('Chrome cerrado. Exportando cookies…');
  }

  // Igual que scripts/login.ts: primero el keyring (Chrome normal cifra con él), luego "basic".
  const preferred = process.env.CODEX_WEB_HTTP_PASSWORD_STORE?.trim() || 'gnome-libsecret';
  const stores = preferred === 'basic' ? ['basic'] : [preferred, 'basic'];
  let best: BrowserCookie[] = [];
  for (const store of stores) {
    let context: BrowserContext | undefined;
    const options = {
      executablePath: chrome, headless: true,
      args: ['--no-first-run', '--no-default-browser-check', `--password-store=${store}`],
      ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
    };
    try {
      try { context = await chromium.launchPersistentContext(profile, { ...options, chromiumSandbox: true }); }
      catch { context = await chromium.launchPersistentContext(profile, { ...options, chromiumSandbox: false }); }
      const state = await context.storageState();
      const cookies = state.cookies as BrowserCookie[];
      if (toNetscape(cookies, site).count > toNetscape(best, site).count) best = cookies;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(message)) {
        throw Error('El perfil de media está en uso: cierra TODAS sus ventanas de Chrome y reintenta con --export.');
      }
      throw error;
    } finally {
      await context?.close();
    }
    if (toNetscape(best, site).count > 0) break;
  }
  const count = saveSiteCookies(site, toNetscape(best, site));
  out(`guardadas ${count} cookies de ${site.label} (0600). Los imports de ${site.label} ya las usan.`);
  return count;
}
