// M0: catalogo de errores de media -> codigo estable + mensaje accionable.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_ERROR_CODES, classifyMediaError, sanitizeMediaDetail } from '../src/media/error-codes';
import { MediaCatalog } from '../src/media/catalog';
import { MediaImporter } from '../src/media/importer';

describe('M0: catalogo de errores de media', () => {
  test('todo codigo tiene un mensaje publico no vacio', () => {
    for (const [code, message] of Object.entries(MEDIA_ERROR_CODES)) {
      expect(code.startsWith('media_')).toBe(true);
      expect(message.length).toBeGreaterThan(0);
    }
  });

  const cases: Array<[string, string]> = [
    ["ERROR: [youtube] YC5Papilj6E: Sign in to confirm you're not a bot.", 'media_youtube_bot_wall'],
    ['ERROR: [youtube] x: Video unavailable; please sign in to watch this video', 'media_youtube_login_required'],
    ['ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests', 'media_rate_limited'],
    ['error: Requested format is not available', 'media_format_unavailable'],
    ['ERROR: Unable to download webpage: [Errno -3] Temporary failure in name resolution', 'media_network_offline'],
    ['ERROR: This video is not available in your country', 'media_geo_blocked'],
    ['ERROR: [youtube] x: Video unavailable', 'media_source_unavailable'],
    ['Downloaded YouTube video identity did not match the canonical URL', 'media_identity_mismatch'],
    ['Media query timed out', 'media_timeout'],
    ['Import requires playable audio/video of at most 30 minutes', 'media_too_long'],
    ['Downloaded media exceeds file limit', 'media_too_large'],
    ['Downloader returned an unauthorized path', 'media_workspace_error'],
  ];
  for (const [raw, code] of cases) {
    test(`${code} <- ${raw.slice(0, 40)}`, () => expect(classifyMediaError(raw).code).toBe(code));
  }

  test('fallo sin firma conocida -> media_download_unknown', () => {
    expect(classifyMediaError('HTTP 403').code).toBe('media_download_unknown');
    expect(classifyMediaError(new Error('boom')).code).toBe('media_download_unknown');
    expect(classifyMediaError(undefined).code).toBe('media_download_unknown');
  });

  test('hint.code fuerza el codigo y usa el mensaje del catalogo', () => {
    const out = classifyMediaError('cualquier cosa', { code: 'media_prepare_failed' });
    expect(out.code).toBe('media_prepare_failed');
    expect(out.message).toBe(MEDIA_ERROR_CODES.media_prepare_failed);
  });

  test('detail_sanitized no filtra URLs, rutas ni tokens y se recorta', () => {
    const raw = "Sign in to confirm you're not a bot. See https://rr3.googlevideo.com/videoplayback?sig=SECRET token=abc123 at /home/danny/.oamaestro/bin/yt-dlp " + 'x'.repeat(400);
    const detail = sanitizeMediaDetail(raw);
    expect(detail).not.toContain('http');
    expect(detail).not.toContain('/home/');
    expect(detail).not.toContain('SECRET');
    expect(detail).not.toContain('abc123');
    expect(detail).toContain('[url]');
    expect(detail).toContain('[path]');
    expect(detail.length).toBeLessThanOrEqual(200);
    const out = classifyMediaError(raw);
    expect(out.code).toBe('media_youtube_bot_wall');
    expect(out.detail_sanitized).toBe(detail);
  });
});

describe('M0: el importer emite un codigo estable', () => {
  test('bot wall de YouTube queda como media_youtube_bot_wall', async () => {
    const root = mkdtempSync(join(tmpdir(), 'isymcp-errorcode-'));
    const catalog = new MediaCatalog(join(root, 'state'));
    const importer = new MediaImporter(catalog, async () => {
      throw Error("ERROR: [youtube] YC5Papilj6E: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies. See https://example.com/x?sig=SECRET");
    });
    const job = importer.start('https://youtu.be/YC5Papilj6E');
    const done = await importer.status(job.job_id, 10);
    expect(done.state).toBe('failed');
    expect(done.error_code).toBe('media_youtube_bot_wall');
    expect(done.error).toContain('not a bot');
    expect(catalog.list()).toHaveLength(0);
    expect(JSON.stringify(done)).not.toContain('SECRET');
  });

  test('timeout y exceso de tamano conservan su codigo', async () => {
    const timeoutRoot = mkdtempSync(join(tmpdir(), 'isymcp-errorcode-timeout-'));
    const timeoutImporter = new MediaImporter(
      new MediaCatalog(join(timeoutRoot, 'state')),
      async () => { await new Promise((r) => setTimeout(r, 200)); return ''; },
      { maxBytes: 100, timeoutMs: 30 },
    );
    const timeoutJob = timeoutImporter.start('https://youtu.be/lHkDE3BahB0');
    expect((await timeoutImporter.status(timeoutJob.job_id, 1)).error_code).toBe('media_timeout');

    const largeRoot = mkdtempSync(join(tmpdir(), 'isymcp-errorcode-large-'));
    const largeImporter = new MediaImporter(
      new MediaCatalog(join(largeRoot, 'state')),
      async (_url, dir) => { const { writeFileSync } = await import('node:fs'); const p = join(dir, 'big.mp4'); writeFileSync(p, Buffer.alloc(101)); return p; },
      { maxBytes: 100 },
    );
    const largeJob = largeImporter.start('https://youtu.be/lHkDE3BahB0');
    expect((await largeImporter.status(largeJob.job_id, 1)).error_code).toBe('media_too_large');
  });
});
