import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaCatalog } from '../src/media/catalog';
import { MediaImporter } from '../src/media/importer';
import { mediaCommand } from '../src/media/cli';
import { PackageCollisionError } from '../src/media/export';
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

test('guided prepare orders preview, confirmation, import, analysis and verified export', async () => {
  const root = home(), catalog = new MediaCatalog(join(root, 'catalog'));
  const output = join(root, 'export'); mkdirSync(output);
  const events: string[] = [], stdout: string[] = [];
  const importer = new MediaImporter(catalog, async (url, dir) => {
    events.push('import');
    const file = join(dir, 'download.wav');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file]);
    return { path: file, video_id: 'abcdefghijk', source_url: url };
  });
  const preview = { url: canonicalUrl, video_id: 'abcdefghijk', title: 'Angel Engine', uploader: 'AnalogVault' };
  await mediaCommand('prepare', [], {
    catalog, importer,
    promptUrl: async () => { events.push('url'); return shortUrl; },
    chooseDirectory: async () => { events.push('folder'); return output; },
    inspect: async url => { events.push('preview'); expect(url).toBe(shortUrl); return preview; },
    confirm: async value => { events.push('confirm'); expect(value).toEqual(preview); return true; },
    prepare: async (_catalog, asset) => {
      events.push('prepare');
      expect(catalog.get(asset.id).downloadReceipt).toEqual({ video_id: preview.video_id, source_url: canonicalUrl });
      return { status: 'ready', generation_id: '00000000-0000-4000-8000-000000000000', duration_seconds: 1, artifacts: [] } as any;
    },
    exportPackage: async (_catalog, asset, manifest, _store, parent, value) => {
      events.push('export');
      expect(parent).toBe(output); expect(value).toEqual(preview); expect(manifest.status).toBe('ready');
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      return { directory: join(parent, 'Angel Engine [abcdefghijk]'), manifest_path: join(parent, 'manifest.json'), manifest_sha256: 'a'.repeat(64) };
    },
    stdout: value => stdout.push(value), stderr: () => {},
  });
  expect(events).toEqual(['url', 'folder', 'preview', 'confirm', 'import', 'prepare', 'export']);
  expect(stdout.some(line => line.includes('Duración: desconocida'))).toBe(true);
  expect(JSON.parse(stdout.at(-1)!)).toMatchObject({ status: 'ready', asset_id: catalog.list()[0].id, package_directory: join(output, 'Angel Engine [abcdefghijk]') });
});

test('guided prepare cancels at URL, picker or confirmation without starting an import', async () => {
  for (const stopAt of ['url', 'folder', 'confirm']) {
    const root = home(), catalog = new MediaCatalog(join(root, 'catalog'));
    let downloads = 0, inspectCalls = 0, confirmations = 0;
    const importer = new MediaImporter(catalog, async () => { downloads++; throw Error('must not import'); });
    const stdout: string[] = [];
    await mediaCommand('prepare', [], {
      catalog, importer,
      promptUrl: async () => stopAt === 'url' ? null : shortUrl,
      chooseDirectory: async () => stopAt === 'folder' ? null : root,
      inspect: async () => { inspectCalls++; return { url: canonicalUrl, video_id: 'abcdefghijk' }; },
      confirm: async () => { confirmations++; return false; },
      stdout: value => stdout.push(value), stderr: () => {},
    });
    expect(downloads).toBe(0);
    expect(catalog.list()).toHaveLength(0);
    expect(stdout.some(line => line.includes('status'))).toBe(false);
    expect(inspectCalls).toBe(stopAt === 'url' || stopAt === 'folder' ? 0 : 1);
    expect(confirmations).toBe(stopAt === 'confirm' ? 1 : 0);
  }
});

test('guided prepare refreshes a legacy catalog asset before packaging verified identity', async () => {
  const root = home(), catalog = new MediaCatalog(join(root, 'catalog'));
  const output = join(root, 'export'); mkdirSync(output);
  const oldFile = join(root, 'old.wav');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', oldFile]);
  const oldAsset = await catalog.add(oldFile, canonicalUrl);
  let downloads = 0, preparedId = '';
  const importer = new MediaImporter(catalog, async (url, dir) => {
    downloads++;
    const file = join(dir, 'refreshed.wav');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', file]);
    return { path: file, video_id: 'abcdefghijk', source_url: url };
  });
  await mediaCommand('prepare', [], {
    catalog, importer, promptUrl: async () => shortUrl,
    chooseDirectory: async () => output,
    inspect: async () => ({ url: canonicalUrl, video_id: 'abcdefghijk', title: 'Angel Engine' }),
    confirm: async () => true,
    prepare: async (_catalog, asset) => {
      preparedId = asset.id;
      return { status: 'ready', generation_id: '00000000-0000-4000-8000-000000000000', artifacts: [] } as any;
    },
    exportPackage: async (_catalog, asset) => {
      expect(asset.downloadReceipt).toEqual({ video_id: 'abcdefghijk', source_url: canonicalUrl });
      return { directory: output, manifest_path: join(output, 'manifest.json'), manifest_sha256: 'c'.repeat(64) };
    },
    stdout: () => {}, stderr: () => {},
  });
  expect(downloads).toBe(1);
  expect(preparedId).not.toBe(oldAsset.id);
  expect(catalog.findBySourceUrl(canonicalUrl)?.id).toBe(preparedId);
});

test('guided prepare retries export in another folder without downloading twice after a collision', async () => {
  const root = home(), catalog = new MediaCatalog(join(root, 'catalog'));
  const first = join(root, 'first'), second = join(root, 'second'); mkdirSync(first); mkdirSync(second);
  let folderCalls = 0, downloads = 0, exports = 0;
  const importer = new MediaImporter(catalog, async (url, dir) => {
    downloads++;
    const file = join(dir, `source-${downloads}.wav`);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file]);
    return { path: file, video_id: 'abcdefghijk', source_url: url };
  });
  await mediaCommand('prepare', [], {
    catalog, importer,
    promptUrl: async () => shortUrl,
    chooseDirectory: async () => ++folderCalls === 1 ? first : second,
    inspect: async () => ({ url: canonicalUrl, video_id: 'abcdefghijk', title: 'Angel Engine' }),
    confirm: async () => true,
    prepare: async () => ({ status: 'ready', generation_id: '00000000-0000-4000-8000-000000000000', artifacts: [] } as any),
    exportPackage: async (_catalog, _asset, _manifest, _store, parent) => {
      exports++;
      if (exports === 1) throw new PackageCollisionError(join(parent, 'Angel Engine [abcdefghijk]'));
      expect(parent).toBe(second);
      return { directory: join(parent, 'Angel Engine [abcdefghijk]'), manifest_path: join(parent, 'manifest.json'), manifest_sha256: 'b'.repeat(64) };
    },
    stdout: () => {}, stderr: () => {},
  });
  expect(folderCalls).toBe(2);
  expect(downloads).toBe(1);
  expect(exports).toBe(2);
});
