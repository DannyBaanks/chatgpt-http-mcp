import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaCatalog } from '../src/media/catalog';
import { MediaImporter } from '../src/media/importer';
import { mediaCommand } from '../src/media/cli';
import { run } from '../src/media/process';

const shortUrl = 'https://www.youtube.com/shorts/abcdefghijk?utm_source=test';
const canonicalUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
const home = () => mkdtempSync(join(tmpdir(), 'isymcp-prepare-cli-'));

test('prepare reuses a registered canonical URL and prints one compact JSON summary', async () => {
  const root = home(), catalog = new MediaCatalog(join(root, 'catalog'));
  const file = join(root, 'audio.wav'); await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file]);
  const asset = await catalog.add(file, canonicalUrl);
  let downloads = 0;
  const importer = new MediaImporter(catalog, async () => { downloads++; throw Error('must not download'); });
  const stdout: string[] = [], stderr: string[] = [];
  const deps = {
    catalog, importer, stdout: value => stdout.push(value), stderr: value => stderr.push(value),
  };
  await mediaCommand('prepare', [shortUrl], deps);
  const secondStart = stderr.length;
  await mediaCommand('prepare', [shortUrl], deps);
  expect(downloads).toBe(0);
  expect(stdout).toHaveLength(2);
  expect(JSON.parse(stdout[0])).toEqual({ asset_id: asset.id, status: 'ready', duration_seconds: 1, sheet_count: 0, segment_count: 1 });
  expect(JSON.parse(stdout[1])).toEqual(JSON.parse(stdout[0]));
  expect(stderr.slice(secondStart)).toEqual(['source: reusing registered media']);
  expect(stderr.join(' ')).not.toContain(root);
});

test('prepare imports a new canonical URL, waits for registration and keeps progress on stderr', async () => {
  const root = home(), catalog = new MediaCatalog(join(root, 'catalog'));
  let downloads = 0;
  const importer = new MediaImporter(catalog, async (url, dir) => {
    downloads++; expect(url).toBe(canonicalUrl);
    const file = join(dir, 'download.wav');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file]);
    return file;
  });
  const stdout: string[] = [], stderr: string[] = [];
  await mediaCommand('prepare', [shortUrl], {
    catalog, importer, stdout: value => stdout.push(value), stderr: value => stderr.push(value),
  });
  expect(downloads).toBe(1);
  expect(catalog.findBySourceUrl(canonicalUrl)?.sourceUrl).toBe(canonicalUrl);
  expect(JSON.parse(stdout[0])).toMatchObject({ status: 'ready', duration_seconds: 1, sheet_count: 0 });
  expect(JSON.parse(stdout[0]).asset_id).toMatch(/^media_/);
  expect(stderr.length).toBeGreaterThan(0);
  expect(stderr.join(' ')).not.toContain(root);
});

test('prepare rejects invalid URLs and incorrect argument counts before importing', async () => {
  const root = home(), catalog = new MediaCatalog(join(root, 'catalog'));
  let downloads = 0;
  const importer = new MediaImporter(catalog, async () => { downloads++; throw Error('unexpected'); });
  const deps = { catalog, importer, prepare: async () => { throw Error('unexpected prepare'); } } as any;
  await expect(mediaCommand('prepare', ['http://127.0.0.1/private'], deps)).rejects.toThrow();
  await expect(mediaCommand('prepare', [], deps)).rejects.toThrow('Usage:');
  await expect(mediaCommand('prepare', [shortUrl, shortUrl], deps)).rejects.toThrow('Usage:');
  expect(downloads).toBe(0);
});

test('failed import reports a safe error and never claims preparation succeeded', async () => {
  const root = home(), catalog = new MediaCatalog(join(root, 'catalog'));
  const importer = new MediaImporter(catalog, async () => { throw Error(`/private/provider/path ${root}`); });
  const stdout: string[] = [];
  await expect(mediaCommand('prepare', [shortUrl], { catalog, importer, stdout: value => stdout.push(value), prepare: async () => { throw Error('must not prepare'); } } as any)).rejects.toThrow(/Download or media validation failed/);
  expect(stdout).toHaveLength(0);
  expect(JSON.stringify(catalog.list())).not.toContain(root);
});
