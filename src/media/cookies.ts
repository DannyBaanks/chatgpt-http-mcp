// src/media/cookies.ts — Cookies OPCIONALES por sitio para importar medios que piden sesión.
//
// Mismo sistema que la sesión de ChatGPT (scripts/login.ts): Chrome normal con un perfil DEDICADO
// para que el operador inicie sesión, y luego Playwright exporta las cookies. Diferencias:
//   - perfil propio de media (no se mezcla con el de ChatGPT);
//   - se guardan POR SITIO, filtradas a sus dominios, en formato cookies.txt (lo que entiende yt-dlp),
//     en ~/.codex-web-http/media-cookies/<sitio>.txt (0600);
//   - opt-in por sitio: yt-dlp solo recibe cookies de un sitio donde el operador hizo `media login`
//     o `media cookies import`, y siempre una COPIA temporal que se borra al terminar la descarga.
// Nunca se imprimen valores de cookies: solo nombres de sitio y conteos.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeHome } from '../codex-sessions';

export interface CookieSite {
  id: string;
  label: string;
  /** Hosts de URL que usan las cookies de este sitio. */
  hosts: string[];
  /** Dominios de cookie que se guardan (el resto del perfil se descarta). */
  cookieDomains: string[];
  loginUrl: string;
}

export const COOKIE_SITES: CookieSite[] = [
  { id: 'instagram', label: 'Instagram', hosts: ['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am'],
    cookieDomains: ['instagram.com'], loginUrl: 'https://www.instagram.com/accounts/login/' },
  { id: 'vimeo', label: 'Vimeo', hosts: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
    cookieDomains: ['vimeo.com'], loginUrl: 'https://vimeo.com/log_in' },
  { id: 'tiktok', label: 'TikTok', hosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com'],
    cookieDomains: ['tiktok.com'], loginUrl: 'https://www.tiktok.com/login' },
  { id: 'x', label: 'X / Twitter', hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
    cookieDomains: ['x.com', 'twitter.com'], loginUrl: 'https://x.com/i/flow/login' },
  { id: 'facebook', label: 'Facebook', hosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.watch'],
    cookieDomains: ['facebook.com'], loginUrl: 'https://www.facebook.com/login' },
  { id: 'reddit', label: 'Reddit', hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'v.redd.it'],
    cookieDomains: ['reddit.com'], loginUrl: 'https://www.reddit.com/login' },
  { id: 'youtube', label: 'YouTube', hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'],
    cookieDomains: ['youtube.com', 'google.com'], loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/' },
];

export function findCookieSite(id: string): CookieSite | null {
  return COOKIE_SITES.find((s) => s.id === id.toLowerCase()) ?? null;
}

export function cookieSiteForUrl(url: string): CookieSite | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return COOKIE_SITES.find((s) => s.hosts.includes(host)) ?? null;
}

export function mediaCookiesDir(env: Record<string, string | undefined> = process.env): string {
  const dir = join(bridgeHome(env), 'media-cookies');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function siteCookiesPath(site: CookieSite, env: Record<string, string | undefined> = process.env): string {
  return join(mediaCookiesDir(env), `${site.id}.txt`);
}

/** Cookie al estilo de Playwright storageState. */
export interface BrowserCookie {
  name: string; value: string; domain: string; path: string; expires: number; httpOnly?: boolean; secure?: boolean;
}

function domainMatches(cookieDomain: string, wanted: string[]): boolean {
  const d = cookieDomain.replace(/^\./, '').toLowerCase();
  return wanted.some((w) => d === w || d.endsWith(`.${w}`));
}

/** Formato Netscape cookies.txt (el de yt-dlp/curl), solo con los dominios del sitio. */
export function toNetscape(cookies: BrowserCookie[], site: CookieSite): { text: string; count: number } {
  const lines = ['# Netscape HTTP Cookie File', `# ISyMCP media cookies: ${site.label} (no compartir)`];
  let count = 0;
  for (const c of cookies) {
    if (!domainMatches(c.domain, site.cookieDomains)) continue;
    if (/[\t\r\n]/.test(c.name + c.value + c.domain + c.path)) continue;
    const domain = c.domain;
    const sub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
    lines.push(`${c.httpOnly ? '#HttpOnly_' : ''}${domain}\t${sub}\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${expires}\t${c.name}\t${c.value}`);
    count++;
  }
  return { text: `${lines.join('\n')}\n`, count };
}

/** Lee un cookies.txt (Netscape) y devuelve solo las líneas de los dominios del sitio. */
export function filterNetscape(raw: string, site: CookieSite): { text: string; count: number } {
  const out = ['# Netscape HTTP Cookie File', `# ISyMCP media cookies: ${site.label} (no compartir)`];
  let count = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    const fields = line.split('\t');
    if (fields.length !== 7) continue;
    if (!domainMatches(fields[0]!.replace(/^#HttpOnly_/, ''), site.cookieDomains)) continue;
    out.push(line);
    count++;
  }
  return { text: `${out.join('\n')}\n`, count };
}

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

export function saveSiteCookies(site: CookieSite, netscape: { text: string; count: number }, env: Record<string, string | undefined> = process.env): number {
  if (netscape.count === 0) throw Error(`No hay cookies de ${site.label} (${site.cookieDomains.join(', ')}): ¿completaste el inicio de sesión?`);
  writePrivate(siteCookiesPath(site, env), netscape.text);
  return netscape.count;
}

export function importSiteCookiesFile(site: CookieSite, file: string, env: Record<string, string | undefined> = process.env): number {
  if (!existsSync(file)) throw Error(`No existe ${file}`);
  return saveSiteCookies(site, filterNetscape(readFileSync(file, 'utf8'), site), env);
}

export function forgetSiteCookies(site: CookieSite, env: Record<string, string | undefined> = process.env): boolean {
  const p = siteCookiesPath(site, env);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export function listSiteCookies(env: Record<string, string | undefined> = process.env): Array<{ site: string; cookies: number }> {
  const dir = mediaCookiesDir(env);
  return readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => ({
    site: f.slice(0, -4),
    cookies: readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim() && (!l.startsWith('#') || l.startsWith('#HttpOnly_'))).length,
  }));
}

/**
 * Copia temporal (0600) de las cookies del sitio de `url` dentro de `dir`, o null si el operador no
 * guardó cookies para ese sitio. Quien la pide la borra al terminar (ver youtube.ts).
 */
export function cookiesCopyFor(url: string, dir: string, env: Record<string, string | undefined> = process.env): string | null {
  const site = cookieSiteForUrl(url);
  if (!site) return null;
  const src = siteCookiesPath(site, env);
  if (!existsSync(src)) return null;
  const copy = join(dir, '.cookies.txt');
  copyFileSync(src, copy);
  if (process.platform !== 'win32') chmodSync(copy, 0o600);
  return copy;
}
