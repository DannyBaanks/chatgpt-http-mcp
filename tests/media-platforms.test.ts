// tests/media-platforms.test.ts — import multiplataforma: cada fallo real dice POR QUÉ, y TikTok usa
// --impersonate chrome cuando el yt-dlp instalado puede (sin cambiar YouTube).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyMediaError } from "../src/media/error-codes";
import { DOCTOR_RULES } from "../src/doctor-rules";
import { canImpersonateChrome, downloadTikTok, downloadYouTube, resetImpersonateCache } from "../src/media/youtube";

// stderr REAL de yt-dlp 2026.08.19 (2026-11-12), recortado.
const REAL = {
  tiktok: "Media process failed (1): ERROR: [TikTok] 6718335390845095173: Unexpected response from webpage request; please report this issue on https://github.com/yt-dlp/yt-dlp/issues",
  instagram: "Media process failed (1): ERROR: [Instagram] CqjVnSVvMml: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in. If it is not, then use --cookies-from-browser or --cookies",
  vimeo: "Media process failed (1): ERROR: [vimeo] 76979871: The web client only works when logged-in. Use --cookies, --cookies-from-browser, --username and --password",
  x: "Media process failed (1): ERROR: [twitter] 1585841080431321088: No video could be found in this tweet",
};

describe("códigos precisos por plataforma", () => {
  it("MP-01: cada fallo real tiene su código, mensaje y regla de doctor", () => {
    const expected = { tiktok: "media_site_blocked", instagram: "media_login_required", vimeo: "media_login_required", x: "media_no_video" } as const;
    for (const [k, raw] of Object.entries(REAL)) {
      const c = classifyMediaError(raw);
      expect(c.code).toBe(expected[k as keyof typeof expected]);
      expect(c.detail_sanitized).toBeTruthy();
      expect(c.detail_sanitized).not.toContain("https://");
      expect(DOCTOR_RULES[c.code].remedy.length).toBeGreaterThan(10);
    }
  });

  it("MP-02: lo de YouTube y lo genérico no cambia", () => {
    expect(classifyMediaError("ERROR: Sign in to confirm you're not a bot").code).toBe("media_youtube_bot_wall");
    expect(classifyMediaError("HTTP 403").code).toBe("media_download_unknown");
  });
});

// yt-dlp falso: responde a --list-impersonate-targets y "descarga" escribiendo los archivos que pide.
function fakeYtDlp(opts: { chrome: boolean; id: string; webpage: string }, calls: string[][]) {
  return async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--list-impersonate-targets")) {
      return Buffer.from(`Client    OS   Source\nChrome    -    curl_cffi${opts.chrome ? "" : " (unavailable)"}\n`);
    }
    const out = args[args.indexOf("-o") + 1]!.replace("%(ext)s", "mp4");
    writeFileSync(out, "x");
    const files = args.flatMap((a, i) => (a === "--print-to-file" ? [[args[i + 1]!, args[i + 2]!]] : []));
    for (const [tpl, path] of files) writeFileSync(path!, tpl!.includes("webpage_url") ? opts.webpage : opts.id);
    return Buffer.from(JSON.stringify(out));
  };
}

describe("--impersonate chrome", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "media-imp-")); resetImpersonateCache(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const TT = "https://www.tiktok.com/@scout2015/video/6718335390845095173";

  afterEach(() => { delete process.env.ISYMCP_YTDLP_IMPERSONATE; });

  it("MP-03: TikTok lo usa si el yt-dlp puede (forzado como en producción con curl_cffi)", async () => {
    process.env.ISYMCP_YTDLP_IMPERSONATE = "1";
    const calls: string[][] = [];
    const r = await downloadTikTok(TT, dir, 1e8, fakeYtDlp({ chrome: true, id: "6718335390845095173", webpage: TT }, calls) as any);
    expect(r.video_id).toBe("6718335390845095173");
    const dl = calls.find((a) => a.includes("-o"))!;
    expect(dl.slice(dl.indexOf("--impersonate"), dl.indexOf("--impersonate") + 2)).toEqual(["--impersonate", "chrome"]);
  });

  it("MP-04: sin curl_cffi (o con un runner inyectado) no se agrega ni se sondea", async () => {
    const calls: string[][] = [];
    await downloadTikTok(TT, dir, 1e8, fakeYtDlp({ chrome: false, id: "6718335390845095173", webpage: TT }, calls) as any);
    expect(calls.find((a) => a.includes("-o"))).not.toContain("--impersonate");
    expect(calls.some((a) => a.includes("--list-impersonate-targets"))).toBe(false);
    process.env.ISYMCP_YTDLP_IMPERSONATE = "0";
    await downloadTikTok(TT, dir, 1e8, fakeYtDlp({ chrome: true, id: "6718335390845095173", webpage: TT }, calls) as any);
    expect(calls.filter((a) => a.includes("-o")).every((a) => !a.includes("--impersonate"))).toBe(true);
  });

  it("MP-05: YouTube nunca lo usa (no cambia lo que ya funciona)", async () => {
    process.env.ISYMCP_YTDLP_IMPERSONATE = "1";
    const calls: string[][] = [];
    await downloadYouTube("https://www.youtube.com/watch?v=BGQWPY4IigY", dir, 1e8, fakeYtDlp({ chrome: true, id: "BGQWPY4IigY", webpage: "" }, calls) as any);
    expect(calls.some((a) => a.includes("--impersonate"))).toBe(false);
    expect(calls.some((a) => a.includes("--list-impersonate-targets"))).toBe(false);
  });

  it("MP-06: se pregunta una sola vez por binario", async () => {
    const calls: string[][] = [];
    const runner = fakeYtDlp({ chrome: true, id: "x", webpage: "" }, calls) as any;
    await Promise.all([canImpersonateChrome("yt-a", runner), canImpersonateChrome("yt-a", runner), canImpersonateChrome("yt-a", runner)]);
    expect(calls.filter((a) => a.includes("--list-impersonate-targets")).length).toBe(1);
  });
});

describe("403 intermitente al bajar datos", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "media-403-")); resetImpersonateCache(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function flaky(failures: string[], calls: string[][]) {
    const ok = fakeYtDlp({ chrome: false, id: "BGQWPY4IigY", webpage: "" }, calls);
    return async (cmd: string, args: string[]) => {
      if (!args.includes("--list-impersonate-targets") && failures.length) { calls.push(args); throw Error(failures.shift()!); }
      return ok(cmd, args);
    };
  }

  it("MP-07: un 403 de datos se reintenta una vez y el import pasa", async () => {
    const calls: string[][] = [];
    const r = await downloadYouTube("https://www.youtube.com/watch?v=BGQWPY4IigY", dir, 1e8,
      flaky(["Media process failed (1): ERROR: unable to download video data: HTTP Error 403: Forbidden"], calls) as any);
    expect(r.video_id).toBe("BGQWPY4IigY");
    expect(calls.filter((a) => a.includes("-o")).length).toBe(2);
  });

  it("MP-08: otros errores no se reintentan; dos 403 seguidos sí fallan", async () => {
    const calls: string[][] = [];
    await expect(downloadYouTube("https://www.youtube.com/watch?v=BGQWPY4IigY", dir, 1e8,
      flaky(["Media process failed (1): ERROR: Video unavailable"], calls) as any)).rejects.toThrow("unavailable");
    expect(calls.length).toBe(1);
    const calls2: string[][] = [];
    const e403 = "Media process failed (1): ERROR: unable to download video data: HTTP Error 403: Forbidden";
    await expect(downloadYouTube("https://www.youtube.com/watch?v=BGQWPY4IigY", dir, 1e8, flaky([e403, e403], calls2) as any)).rejects.toThrow("403");
    expect(calls2.length).toBe(2);
  });
});
