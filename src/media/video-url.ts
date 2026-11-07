import { youtubeSource } from './youtube-url';
import { tiktokSource } from './tiktok-url';
import { basename, extname } from 'node:path';

export type MediaPlatform = 'youtube' | 'tiktok' | 'instagram' | 'twitter' | 'direct' | 'generic';

export type MediaSource =
  | { platform: 'youtube'; source_url: string; video_id: string }
  | { platform: 'tiktok'; source_url: string; video_id?: string }
  | { platform: 'instagram'; source_url: string; video_id: string; media_id: string }
  | { platform: 'twitter'; source_url: string; video_id: string; tweet_id: string }
  | { platform: 'direct'; source_url: string; video_id: string; filename: string; ext: string }
  | { platform: 'generic'; source_url: string; video_id?: string };

const YOUTUBE_HOSTS = new Set(['youtu.be', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am']);
const TWITTER_HOSTS = new Set(['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com']);
export const MEDIA_EXTENSIONS = new Set(['.mp4', '.mp3', '.wav', '.m4a', '.webm', '.ogg', '.flac', '.aac', '.mov', '.mkv', '.opus']);

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '169.254.169.254') return true;
  return false;
}

export function instagramSource(input: string): { source_url: string; media_id: string; video_id: string } {
  let url: URL;
  try { url = new URL(input); } catch { throw Error('Invalid Instagram URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error('Use a public HTTPS Instagram URL');
  const match = /^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match) throw Error('Only public Instagram reels, posts, and TV links are supported');
  const media_id = match[1];
  return { source_url: `https://www.instagram.com/reel/${media_id}/`, media_id, video_id: media_id };
}

export function twitterSource(input: string): { source_url: string; tweet_id: string; video_id: string } {
  let url: URL;
  try { url = new URL(input); } catch { throw Error('Invalid Twitter/X URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error('Use a public HTTPS Twitter/X URL');
  const match = /^\/[^/]+\/status\/(\d+)\/?$/.exec(url.pathname);
  if (!match) throw Error('Only public Twitter/X status links are supported');
  const tweet_id = match[1];
  return { source_url: `https://x.com/i/status/${tweet_id}`, tweet_id, video_id: tweet_id };
}

export function directMediaSource(input: string): { source_url: string; filename: string; ext: string; video_id: string } {
  let url: URL;
  try { url = new URL(input); } catch { throw Error('Invalid direct media URL'); }
  if (url.protocol !== 'https:') {
    throw Error('Direct media links must use HTTPS');
  }
  if (url.username || url.password) {
    throw Error('Direct media links must not include credentials');
  }
  if (isPrivateHost(url.hostname)) {
    throw Error('Private and local network addresses are not permitted');
  }
  const ext = extname(url.pathname).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(ext)) throw Error(`Unsupported direct media extension: ${ext || 'none'}`);
  const filename = basename(url.pathname);
  const video_id = basename(url.pathname, ext);
  return {
    source_url: url.toString(),
    filename,
    ext,
    video_id: video_id || 'media',
  };
}

export function mediaSource(input: string): MediaSource {
  let url: URL;
  try { url = new URL(input); } catch { throw Error('Invalid public video URL'); }

  if (url.protocol !== 'https:') {
    throw Error('Only public HTTPS media links are permitted');
  }

  // Rechazar credenciales en URL
  if (url.username || url.password) throw Error('Credentials in media URLs are not permitted');

  const host = url.hostname.toLowerCase();

  if (isPrivateHost(host)) {
    throw Error('Private and local network addresses are not permitted');
  }

  // Guardias contra dominios trampa / lookalike
  if (host.includes('tiktok') && !TIKTOK_HOSTS.has(host)) {
    throw Error('Invalid TikTok host');
  }
  if ((host.includes('youtube') || host.includes('youtu.be')) && !YOUTUBE_HOSTS.has(host)) {
    throw Error('Invalid YouTube host');
  }
  if (host.includes('instagram') && !INSTAGRAM_HOSTS.has(host)) {
    throw Error('Invalid Instagram host');
  }
  if ((host.includes('twitter') || host === 'x.com') && !TWITTER_HOSTS.has(host)) {
    throw Error('Invalid Twitter/X host');
  }

  // 1. YouTube
  if (YOUTUBE_HOSTS.has(host)) {
    const source_url = youtubeSource(input);
    return { platform: 'youtube', source_url, video_id: new URL(source_url).searchParams.get('v')! };
  }

  // 2. TikTok
  if (TIKTOK_HOSTS.has(host)) {
    return { platform: 'tiktok', ...tiktokSource(input) };
  }

  // 3. Instagram
  if (INSTAGRAM_HOSTS.has(host)) {
    return { platform: 'instagram', ...instagramSource(input) };
  }

  // 4. Twitter / X
  if (TWITTER_HOSTS.has(host)) {
    return { platform: 'twitter', ...twitterSource(input) };
  }

  // 5. Enlaces directos a archivos multimedia (.mp4, .mp3, .wav, etc.)
  const ext = extname(url.pathname).toLowerCase();
  if (MEDIA_EXTENSIONS.has(ext)) {
    return { platform: 'direct', ...directMediaSource(input) };
  }

  // 6. Genérico soportado por yt-dlp (HTTPS público)
  const segments = url.pathname.split('/').filter(Boolean);
  const lastSeg = segments[segments.length - 1];
  return {
    platform: 'generic',
    source_url: url.toString(),
    ...(lastSeg ? { video_id: lastSeg } : {}),
  };
}
