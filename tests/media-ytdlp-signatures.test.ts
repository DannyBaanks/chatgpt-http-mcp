// M1: firmas del stderr de yt-dlp -> codigo estable.
import { describe, expect, test } from 'bun:test';
import { classifyYtDlpFailure, isBotWallFailure, YTDLP_SIGNATURES } from '../src/media/ytdlp-signatures';

describe('M1: firmas de yt-dlp', () => {
  const cases: Array<[string, string]> = [
    ["ERROR: [youtube] YC5Papilj6E: Sign in to confirm you're not a bot.", 'media_youtube_bot_wall'],
    ['ERROR: [youtube] x: This video is private', 'media_youtube_login_required'],
    ['ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests', 'media_rate_limited'],
    ['error: Requested format is not available', 'media_format_unavailable'],
    ['ERROR: Unable to download webpage: [Errno -3] Temporary failure in name resolution', 'media_network_offline'],
    ['ERROR: This video is not available in your country', 'media_geo_blocked'],
    ['ERROR: [youtube] x: Video unavailable', 'media_source_unavailable'],
  ];
  for (const [raw, code] of cases) {
    test(`${code} <- ${raw.slice(0, 44)}`, () => expect(classifyYtDlpFailure(raw)).toBe(code));
  }

  test('stderr sin firma conocida -> media_download_unknown', () => {
    expect(classifyYtDlpFailure('ERROR: unable to extract player response')).toBe('media_download_unknown');
    expect(classifyYtDlpFailure(undefined)).toBe('media_download_unknown');
  });

  test('isBotWallFailure solo para el muro anti-bot', () => {
    expect(isBotWallFailure("ERROR: Sign in to confirm you're not a bot.")).toBe(true);
    expect(isBotWallFailure(new Error('not a bot'))).toBe(true);
    expect(isBotWallFailure('ERROR: This video is unavailable')).toBe(false);
    expect(isBotWallFailure(undefined)).toBe(false);
  });

  test('la tabla no tiene codigos fuera del catalogo de media', () => {
    for (const [, code] of YTDLP_SIGNATURES) expect(code.startsWith('media_')).toBe(true);
  });
});
