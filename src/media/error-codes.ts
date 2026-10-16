// error-codes.ts — M0: catalogo cerrado de fallos de media.
//
// Analogo a src/error-taxonomy.ts (path web): un fallo de media se representa
// por un CODIGO estable `media_*` mas un mensaje publico accionable. El detalle
// crudo del proveedor NO se propaga: puede incluir URLs firmadas, cookies o
// rutas locales; solo viaja un `detail_sanitized` recortado y sin secretos.
//
// Los mensajes conservan byte a byte el texto publico previo de importer.ts
// para las cuatro causas que ya existian (identity/timeout/limit/fallback).

import { YTDLP_SIGNATURES } from './ytdlp-signatures';

export const MEDIA_ERROR_CODES = {
  media_identity_mismatch: 'Downloaded video identity did not match the requested URL',
  media_timeout: 'Import timed out; try a shorter video',
  media_too_large: 'Import exceeded the local size limit',
  media_too_long: 'Import requires playable audio/video of at most 30 minutes',
  media_youtube_bot_wall:
    "YouTube requires confirming you are not a bot; this import runs without cookies",
  media_youtube_login_required:
    'YouTube requires a signed-in session for this video; imports run without cookies',
  media_rate_limited: 'YouTube rate limited this download; try again later',
  media_source_unavailable: 'The video is unavailable (private, removed or restricted)',
  media_geo_blocked: 'The video is not available in this region',
  media_format_unavailable: 'YouTube did not offer a downloadable format',
  media_tool_missing: 'yt-dlp or ffmpeg is missing on this machine',
  media_network_offline: 'No network connection or DNS resolution failed',
  media_workspace_error: 'The workspace or disk is unavailable',
  media_prepare_failed:
    'Media preparation failed; the registered source and verified partial results are preserved. Retry with the same URL.',
  media_catalog_unavailable: 'Media catalog unavailable or invalid offset',
  media_invalid_url: 'Use a public HTTPS YouTube video URL',
  media_lookup_failed:
    'Media lookup failed; the source may be unavailable or its integrity could not be verified.',
  media_asset_changed: 'Asset changed: register again',
  media_invalid_request: 'Invalid media request',
  media_busy: 'Media worker busy; retry after current query finishes',
  media_download_unknown:
    'Download or media validation failed; source may be unavailable, require login, or be blocked',
  media_unknown: 'Media operation failed',
} as const;

export type MediaErrorCode = keyof typeof MEDIA_ERROR_CODES;

export interface MediaError {
  code: MediaErrorCode;
  message: string;
  detail_sanitized?: string;
}

// Primero las firmas del proveedor (yt-dlp, compartidas con youtube.ts), luego
// los throws internos de media. Orden: de lo especifico a lo generico. Los
// mensajes publicos historicos de importer.ts (identity/timeout/limit/fallback)
// se conservan en el catalogo.
const INTERNAL_SIGNATURES: ReadonlyArray<readonly [RegExp, MediaErrorCode]> = [
  [/identity/i, 'media_identity_mismatch'],
  [/timed out|timeout/i, 'media_timeout'],
  [/at most 30 minutes|duration <= 1800|longer than 30 minutes/i, 'media_too_long'],
  [/exceeds file limit|exceeds disk limit|insufficient free disk space|max.?filesize|exceeds? (?:the )?local size limit/i, 'media_too_large'],
  [/unauthorized path|workspace|no space left|read.?only file system/i, 'media_workspace_error'],
  [/public https youtube|invalid youtube url|only individual youtube/i, 'media_invalid_url'],
];

const SIGNATURES: ReadonlyArray<readonly [RegExp, MediaErrorCode]> = [
  ...YTDLP_SIGNATURES,
  ...INTERNAL_SIGNATURES,
];

const MAX_DETAIL = 200;

/** Recorta y limpia el detalle: sin URLs, sin rutas absolutas, sin tokens. */
export function sanitizeMediaDetail(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  return text
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(?:token|cookie|sig|signature|expire|hmac)=[^\s&]+/gi, '$1=[redacted]')
    .replace(/(?:\/[\w.\-]+){2,}/g, '[path]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL);
}

/**
 * Clasifica un fallo de media a `{code, message, detail_sanitized?}`.
 * `hint.code` fuerza el codigo cuando el throw site ya lo conoce.
 */
export function classifyMediaError(
  raw: unknown,
  hint: { code?: MediaErrorCode } = {},
): MediaError {
  if (hint.code) return { code: hint.code, message: MEDIA_ERROR_CODES[hint.code] };
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  const detail = sanitizeMediaDetail(text);
  for (const [pattern, code] of SIGNATURES) {
    if (pattern.test(text)) return withDetail(code, detail);
  }
  return withDetail('media_download_unknown', detail);
}

function withDetail(code: MediaErrorCode, detail: string): MediaError {
  return detail ? { code, message: MEDIA_ERROR_CODES[code], detail_sanitized: detail } : { code, message: MEDIA_ERROR_CODES[code] };
}

/** Error de media con codigo estable; quien lo captura puede imprimir `code`. */
export class MediaFailure extends Error {
  readonly code: MediaErrorCode;
  readonly detail_sanitized?: string;
  constructor(code: MediaErrorCode, message?: string, detail_sanitized?: string) {
    super(message ?? MEDIA_ERROR_CODES[code]);
    this.name = 'MediaFailure';
    this.code = code;
    this.detail_sanitized = detail_sanitized;
  }
}
