// ytdlp-signatures.ts — M1: firmas del stderr de yt-dlp -> codigo estable.
//
// Vive aparte de error-codes.ts para que el retry de youtube.ts y el
// clasificador del importer compartan UNA sola tabla (sin duplicar firmas).
// Solo clasifica texto del proveedor; los throws internos los cubre
// error-codes.ts.

import type { MediaErrorCode } from './error-codes';

function text(raw: unknown): string {
  return raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
}

// De lo especifico a lo generico.
export const YTDLP_SIGNATURES: ReadonlyArray<readonly [RegExp, MediaErrorCode]> = [
  [/sign in to confirm|not a bot/i, 'media_youtube_bot_wall'],
  [/please sign in|requires? (?:a )?(?:signed.?in|login|authentication)|this video is private/i, 'media_youtube_login_required'],
  // Plataformas no-YouTube (medido 2026-11-12 con yt-dlp 2026.08.19):
  //   Instagram "sent an empty media response ... use --cookies", Vimeo "only works when logged-in",
  //   TikTok "Unexpected response from webpage request" (sin impersonation), X "No video could be found".
  [/use --cookies|--cookies-from-browser|only works when logged.?in|logged.?in|login required|empty media response/i, 'media_login_required'],
  [/unexpected response from webpage request|impersonat|blocked by|captcha/i, 'media_site_blocked'],
  [/no video could be found|there'?s no video|no media found|does not contain (?:a )?video/i, 'media_no_video'],
  [/too many requests|http error 429|rate.?limit/i, 'media_rate_limited'],
  [/requested format is not available|no video formats found|unsupported url|no downloadable format/i, 'media_format_unavailable'],
  [/unable to download webpage|getaddrinfo|name resolution|network is unreachable|connection refused|temporary failure/i, 'media_network_offline'],
  [/not available in your country|geo.?block|geo.?restrict/i, 'media_geo_blocked'],
  [/video unavailable|removed by the uploader|has been removed|no longer available/i, 'media_source_unavailable'],
];

/** ¿El fallo es el muro anti-bot de YouTube? Lo usa el retry web_embedded. */
export function isBotWallFailure(raw: unknown): boolean {
  return /sign in to confirm|not a bot/i.test(text(raw));
}

/** Primer codigo que matchea el stderr de yt-dlp, o media_download_unknown. */
export function classifyYtDlpFailure(raw: unknown): MediaErrorCode {
  const body = text(raw);
  for (const [pattern, code] of YTDLP_SIGNATURES) if (pattern.test(body)) return code;
  return 'media_download_unknown';
}
