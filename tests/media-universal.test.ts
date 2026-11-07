import { test, expect } from 'bun:test';
import * as downloader from '../src/media/youtube';
import { mediaSource } from '../src/media/video-url';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../src/media/process';

test('Instagram canonicalization accepts reels and posts while stripping query parameters', () => {
  expect(mediaSource('https://www.instagram.com/reel/DC123456789/?igsh=XYZ123')).toEqual({
    platform: 'instagram',
    source_url: 'https://www.instagram.com/reel/DC123456789/',
    media_id: 'DC123456789',
    video_id: 'DC123456789',
  });
  expect(mediaSource('https://instagram.com/p/DB987654321/')).toEqual({
    platform: 'instagram',
    source_url: 'https://www.instagram.com/reel/DB987654321/',
    media_id: 'DB987654321',
    video_id: 'DB987654321',
  });
});

test('Twitter / X canonicalization normalizes twitter.com to x.com and extracts tweet ID', () => {
  expect(mediaSource('https://twitter.com/sama/status/1234567890123456789?s=20')).toEqual({
    platform: 'twitter',
    source_url: 'https://x.com/i/status/1234567890123456789',
    tweet_id: '1234567890123456789',
    video_id: '1234567890123456789',
  });
  expect(mediaSource('https://x.com/i/status/9876543210987654321')).toEqual({
    platform: 'twitter',
    source_url: 'https://x.com/i/status/9876543210987654321',
    tweet_id: '9876543210987654321',
    video_id: '9876543210987654321',
  });
});

test('Direct media URL canonicalization supports audio and video extensions preserving signed parameters', () => {
  expect(mediaSource('https://example.com/assets/audio/podcast.mp3?token=abc')).toEqual({
    platform: 'direct',
    source_url: 'https://example.com/assets/audio/podcast.mp3?token=abc',
    filename: 'podcast.mp3',
    ext: '.mp3',
    video_id: 'podcast',
  });
  expect(mediaSource('https://cdn.example.org/videos/nature-clip.mp4')).toEqual({
    platform: 'direct',
    source_url: 'https://cdn.example.org/videos/nature-clip.mp4',
    filename: 'nature-clip.mp4',
    ext: '.mp4',
    video_id: 'nature-clip',
  });
  expect(mediaSource('https://cdn.example.org/audio/sample.wav').platform).toBe('direct');
  expect(mediaSource('https://cdn.example.org/audio/sample.m4a').platform).toBe('direct');
  expect(mediaSource('https://cdn.example.org/video/sample.webm').platform).toBe('direct');
  expect(mediaSource('https://cdn.example.org/video/sample.mkv').platform).toBe('direct');
});

test('Generic media URL canonicalization accepts https URLs for yt-dlp discovery', () => {
  expect(mediaSource('https://vimeo.com/123456789')).toEqual({
    platform: 'generic',
    source_url: 'https://vimeo.com/123456789',
    video_id: '123456789',
  });
});

test('Media source security guardrails reject credentials, non-https, and local targets', () => {
  expect(() => mediaSource('http://example.com/video.mp4')).toThrow(/HTTPS/i);
  expect(() => mediaSource('https://user:pass@example.com/video.mp4')).toThrow(/Credentials/i);
  expect(() => mediaSource('https://127.0.0.1/video.mp4')).toThrow(/Private/i);
  expect(() => mediaSource('https://localhost/video.mp4')).toThrow(/Private/i);
  expect(() => mediaSource('https://192.168.1.1/video.mp4')).toThrow(/Private/i);
});

test('downloadSocialMedia invokes yt-dlp and parses metadata receipt', async () => {
  const download = (downloader as any).downloadSocialMedia;
  expect(typeof download).toBe('function');
  const root = mkdtempSync(join(tmpdir(), 'isymcp-social-download-'));
  const staging = join(root, 'stage');
  mkdirSync(staging);
  const file = join(staging, 'social.mp4');
  let argsSeen: string[] = [];

  const runner: typeof run = async (_command, args) => {
    argsSeen = args;
    writeFileSync(file, 'video-payload');
    const idFlag = args.indexOf('--print-to-file');
    writeFileSync(args[idFlag + 2], 'DC123456789\n');
    const pageFlag = args.indexOf('--print-to-file', idFlag + 1);
    writeFileSync(args[pageFlag + 2], 'https://www.instagram.com/reel/DC123456789/\n');
    return Buffer.from(`${JSON.stringify(file)}\n`);
  };

  const result = await download('https://www.instagram.com/reel/DC123456789/', staging, 1024, 'instagram', runner);
  expect(result.platform).toBe('instagram');
  expect(result.video_id).toBe('DC123456789');
  expect(result.canonical_url).toBe('https://www.instagram.com/reel/DC123456789/');
  expect(argsSeen).toContain('--no-playlist');
  expect(argsSeen).toContain('--ignore-config');
});
