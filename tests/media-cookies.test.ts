// tests/media-cookies.test.ts — cookies opcionales por sitio para medios que piden sesión.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cookieSiteForUrl, cookiesCopyFor, filterNetscape, findCookieSite, forgetSiteCookies, importSiteCookiesFile, listSiteCookies,
  saveSiteCookies, toNetscape } from "../src/media/cookies";
import { downloadSocialMedia, resetImpersonateCache } from "../src/media/youtube";

let home: string;
let prev: string | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "media-cookies-")); prev = process.env.CODEX_WEB_HTTP_HOME; process.env.CODEX_WEB_HTTP_HOME = home; resetImpersonateCache(); });
afterEach(() => { if (prev === undefined) delete process.env.CODEX_WEB_HTTP_HOME; else process.env.CODEX_WEB_HTTP_HOME = prev; rmSync(home, { recursive: true, force: true }); });

const ig = findCookieSite("instagram")!;
const browserCookies = [
  { name: "sessionid", value: "SECRETO-IG", domain: ".instagram.com", path: "/", expires: 2000000000, httpOnly: true, secure: true },
  { name: "csrftoken", value: "c", domain: "www.instagram.com", path: "/", expires: -1, secure: true },
  { name: "SID", value: "SECRETO-GOOGLE", domain: ".google.com", path: "/", expires: 2000000000 },
];

describe("cookies por sitio", () => {
  it("MC-01: solo se guardan las cookies de los dominios del sitio, en formato cookies.txt", () => {
    const n = toNetscape(browserCookies, ig);
    expect(n.count).toBe(2);
    expect(n.text).toStartWith("# Netscape HTTP Cookie File");
    expect(n.text).toContain("#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t2000000000\tsessionid\tSECRETO-IG");
    expect(n.text).toContain("www.instagram.com\tFALSE\t/\tTRUE\t0\tcsrftoken\tc");
    expect(n.text).not.toContain("SECRETO-GOOGLE");
  });

  it("MC-02: guardado 0600, listado sin valores, import filtrado y olvido", () => {
    saveSiteCookies(ig, toNetscape(browserCookies, ig));
    const p = join(home, "media-cookies", "instagram.txt");
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(listSiteCookies()).toEqual([{ site: "instagram", cookies: 2 }]);
    expect(JSON.stringify(listSiteCookies())).not.toContain("SECRETO");
    const vimeo = findCookieSite("vimeo")!;
    const f = join(home, "export.txt");
    writeFileSync(f, "# Netscape HTTP Cookie File\n.vimeo.com\tTRUE\t/\tTRUE\t0\tvuid\tv\n.evil.com\tTRUE\t/\tTRUE\t0\tx\ty\n");
    expect(importSiteCookiesFile(vimeo, f)).toBe(1);
    expect(readFileSync(join(home, "media-cookies", "vimeo.txt"), "utf8")).not.toContain("evil");
    expect(forgetSiteCookies(vimeo)).toBe(true);
    expect(() => saveSiteCookies(vimeo, filterNetscape("", vimeo))).toThrow("No hay cookies");
  });

  it("MC-03: la URL decide el sitio; sin cookies guardadas no hay copia", () => {
    expect(cookieSiteForUrl("https://www.instagram.com/reel/x/")?.id).toBe("instagram");
    expect(cookieSiteForUrl("https://evil-instagram.com/reel/x/")).toBeNull();
    const dir = mkdtempSync(join(home, "dl-"));
    expect(cookiesCopyFor("https://vimeo.com/1", dir)).toBeNull();
    saveSiteCookies(ig, toNetscape(browserCookies, ig));
    expect(cookiesCopyFor("https://vimeo.com/1", dir)).toBeNull(); // otro sitio: no recibe las de Instagram
    expect(cookiesCopyFor("https://www.instagram.com/reel/abc/", dir)).toBe(join(dir, ".cookies.txt"));
  });
});

describe("descarga con cookies", () => {
  function fake(fail: boolean, seen: { args?: string[]; existed?: boolean }) {
    return async (_c: string, args: string[]) => {
      if (args.includes("--list-impersonate-targets")) return Buffer.from("Chrome  -  curl_cffi (unavailable)\n");
      seen.args = args;
      const i = args.indexOf("--cookies");
      seen.existed = i >= 0 && existsSync(args[i + 1]!);
      if (fail) throw Error("Media process failed (1): ERROR: boom");
      const out = args[args.indexOf("-o") + 1]!.replace("%(ext)s", "mp4");
      writeFileSync(out, "x");
      for (let k = 0; k < args.length; k++) if (args[k] === "--print-to-file") writeFileSync(args[k + 2]!, args[k + 1]!.includes("webpage") ? "https://www.instagram.com/reel/abc/" : "abc");
      return Buffer.from(JSON.stringify(out));
    };
  }

  it("MC-04: yt-dlp recibe una copia y se borra al terminar (también si falla)", async () => {
    saveSiteCookies(ig, toNetscape(browserCookies, ig));
    for (const fail of [false, true]) {
      const dir = mkdtempSync(join(home, "dl-"));
      const seen: { args?: string[]; existed?: boolean } = {};
      const p = downloadSocialMedia("https://www.instagram.com/reel/abc/", dir, 1e8, "instagram", fake(fail, seen) as any);
      if (fail) await expect(p).rejects.toThrow("boom"); else await p;
      expect(seen.args).toContain("--cookies");
      expect(seen.existed).toBe(true);
      expect(readdirSync(dir)).not.toContain(".cookies.txt");
    }
  });

  it("MC-05: sin cookies guardadas, yt-dlp no recibe --cookies", async () => {
    const dir = mkdtempSync(join(home, "dl-"));
    const seen: { args?: string[] } = {};
    await downloadSocialMedia("https://www.instagram.com/reel/abc/", dir, 1e8, "instagram", fake(false, seen) as any);
    expect(seen.args).not.toContain("--cookies");
  });
});
