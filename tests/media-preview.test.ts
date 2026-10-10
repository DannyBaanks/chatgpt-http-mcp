import { test, expect } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectYouTube, chooseOutputDirectory } from '../src/media/preview';
import { run } from '../src/media/process';

const shortUrl = 'https://www.youtube.com/shorts/abcdefghijk?utm_source=test';
const canonicalUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
const root = () => mkdtempSync(join(tmpdir(), 'isymcp-preview-test-'));

test('metadata preflight maps real fields and does not download or read yt-dlp config', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: typeof run = async (command, args) => {
    calls.push({ command, args });
    return Buffer.from(JSON.stringify({
      id: 'abcdefghijk', webpage_url: canonicalUrl, title: 'Angel Engine', uploader: 'AnalogVault',
      duration: 83, width: 720, height: 720, filesize: 123456,
    }));
  };

  const result = await inspectYouTube(shortUrl, runner);

  expect(result).toEqual({
    url: canonicalUrl, video_id: 'abcdefghijk', title: 'Angel Engine', uploader: 'AnalogVault',
    duration_seconds: 83, resolution: '720x720', estimated_bytes: 123456,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toContain(canonicalUrl);
  expect(calls[0].args).toContain('--skip-download');
  expect(calls[0].args).toContain('--ignore-config');
  expect(calls[0].args).toContain('--no-plugin-dirs');
  expect(calls[0].args).toContain('--no-cache-dir');
});

test('metadata preflight preserves unknown fields and rejects an ID different from the URL', async () => {
  const unknownRunner: typeof run = async () => Buffer.from(JSON.stringify({ id: 'abcdefghijk' }));
  expect(await inspectYouTube(shortUrl, unknownRunner)).toEqual({ url: canonicalUrl, video_id: 'abcdefghijk' });

  const wrongIdRunner: typeof run = async () => Buffer.from(JSON.stringify({ id: 'mnopqrstuvw', title: 'Wrong video' }));
  await expect(inspectYouTube(shortUrl, wrongIdRunner)).rejects.toThrow(/video identity/i);
});

test('metadata preflight strips terminal controls from untrusted metadata', async () => {
  const runner: typeof run = async () => Buffer.from(JSON.stringify({
    id: 'abcdefghijk', title: 'safe\u001b[31m RED\nsecond line', uploader: 'channel\u0007',
  }));
  const preview = await inspectYouTube(shortUrl, runner);
  expect(preview.title).toBe('safe RED second line');
  expect(preview.uploader).toBe('channel');
});

test('metadata preflight hides downloader stderr that may contain signed URLs or local paths', async () => {
  const runner: typeof run = async () => { throw Error('Media process failed (1): /private/path signed_url=SECRET_SENTINEL'); };
  let message = '';
  try { await inspectYouTube(shortUrl, runner); } catch (error) { message = (error as Error).message; }
  expect(message).toBe('Could not inspect YouTube metadata; check the public link and try again');
  expect(message).not.toContain('SECRET_SENTINEL');
});

test('Linux directory picker passes literal arguments and returns zenity selection', async () => {
  const temp = root(), bin = join(temp, 'bin'), selected = join(temp, 'output;not-a-command');
  mkdirSync(bin); mkdirSync(selected);
  const zenity = join(bin, 'zenity'); writeFileSync(zenity, '#!/bin/sh\n'); chmodSync(zenity, 0o755);
  let call: { command: string; args: string[] } | undefined;
  const runner: typeof run = async (command, args) => { call = { command, args }; return Buffer.from(`${selected}\n`); };

  expect(await chooseOutputDirectory({ platform: 'linux', runner, env: { PATH: bin, HOME: temp } })).toBe(selected);
  expect(call?.command).toBe(zenity);
  expect(call?.args).toContain('--directory');
  expect(call?.args).not.toContain(selected);
});

test('Linux directory picker supports kdialog and treats user cancellation as null', async () => {
  const temp = root(), bin = join(temp, 'bin'), selected = join(temp, 'chosen');
  mkdirSync(bin); mkdirSync(selected);
  const kdialog = join(bin, 'kdialog'); writeFileSync(kdialog, '#!/bin/sh\n'); chmodSync(kdialog, 0o755);
  const runner: typeof run = async () => Buffer.from(`${selected}\n`);
  expect(await chooseOutputDirectory({ platform: 'linux', runner, env: { PATH: bin, HOME: temp } })).toBe(selected);

  const cancelRunner: typeof run = async () => { throw Error('Media process failed (1): canceled'); };
  expect(await chooseOutputDirectory({ platform: 'linux', runner: cancelRunner, env: { PATH: bin, HOME: temp } })).toBeNull();
});

test('Linux directory picker fails clearly when no supported dialog exists or it errors', async () => {
  const temp = root(), emptyPath = join(temp, 'empty'); mkdirSync(emptyPath);
  await expect(chooseOutputDirectory({ platform: 'linux', env: { PATH: emptyPath, HOME: temp } })).rejects.toThrow(/zenity|kdialog/i);

  const bin = join(temp, 'bin'); mkdirSync(bin);
  const zenity = join(bin, 'zenity'); writeFileSync(zenity, '#!/bin/sh\n'); chmodSync(zenity, 0o755);
  const errorRunner: typeof run = async () => { throw Error('Media process failed (7): private provider output'); };
  await expect(chooseOutputDirectory({ platform: 'linux', runner: errorRunner, env: { PATH: bin, HOME: temp } }))
    .rejects.toThrow(/folder chooser/i);
  await expect(chooseOutputDirectory({ platform: 'darwin', env: { PATH: emptyPath } })).rejects.toThrow(/Linux/i);
});
