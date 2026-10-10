import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { MediaCatalog, digest } from '../src/media/catalog';
import { exportMediaPackage, PackageCollisionError, PackageExportError } from '../src/media/export';
import { MediaPreparationStore } from '../src/media/preparation-store';
import { prepareMedia } from '../src/media/preparation';
import { run } from '../src/media/process';

const sourceUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
const preview = { url: sourceUrl, video_id: 'abcdefghijk', title: 'Angel Engine Part 63', duration_seconds: 2, resolution: '128x72' };
const root = () => mkdtempSync(join(tmpdir(), 'isymcp-media-export-'));

async function fixture(verified = true) {
  const base = root(), parent = join(base, 'output'), home = join(base, 'catalog'), file = join(base, 'source.mp4');
  mkdirSync(parent);
  await run('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=128x72:r=8:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'mpeg4', '-q:v', '31',
    '-c:a', 'aac', '-shortest', file,
  ], 1024 * 1024, 30000);
  const catalog = new MediaCatalog(home), asset = await catalog.add(file, sourceUrl, verified ? { video_id: 'abcdefghijk', source_url: sourceUrl } : undefined);
  const store = new MediaPreparationStore(home), manifest = await prepareMedia(catalog, asset, store);
  expect(manifest.status).toBe('ready');
  return { base, parent, catalog, asset, store, manifest };
}

test('export publishes source and verified full audio/contact-sheet artifacts with a hashed receipt', async () => {
  const state = await fixture();
  const result = await exportMediaPackage(state.catalog, state.asset, state.manifest, state.store, state.parent, preview);
  const exported = JSON.parse(readFileSync(result.manifest_path, 'utf8'));
  expect(basename(result.directory)).toBe('Angel Engine Part 63 [abcdefghijk]');
  expect(dirname(result.directory)).toBe(state.parent);
  expect(exported).toMatchObject({ schema_version: 'isymcp-media-package/1', source: {
    asset_id: state.asset.id, source_url: sourceUrl, video_id: 'abcdefghijk', sha256: state.asset.sha256, bytes: state.asset.bytes,
    download_receipt: { video_id: 'abcdefghijk', source_url: sourceUrl },
  }, preview, preparation: { status: 'ready', generation_id: state.manifest.generation_id } });
  expect(result.manifest_sha256).toBe(digest(readFileSync(result.manifest_path)));
  expect(exported.files.map((file: any) => file.kind)).toEqual(['source', 'audio_scan', 'contact_sheet']);
  for (const file of exported.files) {
    const bytes = readFileSync(join(result.directory, file.path));
    expect(bytes.length).toBe(file.bytes);
    expect(digest(bytes)).toBe(file.sha256);
  }
  expect(readFileSync(join(result.directory, 'source.mp4'))).toEqual(readFileSync(state.asset.realPath));
  expect(state.catalog.findBySourceUrl(sourceUrl)?.id).toBe(state.asset.id);
});

test('export sanitizes an untrusted title and refuses an existing package without changing it', async () => {
  const state = await fixture();
  const hostile = { ...preview, title: '../../bad/CON:\u0000name\n' };
  const result = await exportMediaPackage(state.catalog, state.asset, state.manifest, state.store, state.parent, hostile);
  expect(dirname(result.directory)).toBe(state.parent);
  expect(basename(result.directory)).not.toContain('/');
  const originalManifest = readFileSync(result.manifest_path);
  await expect(exportMediaPackage(state.catalog, state.asset, state.manifest, state.store, state.parent, hostile))
    .rejects.toBeInstanceOf(PackageCollisionError);
  expect(readFileSync(result.manifest_path)).toEqual(originalManifest);
});

test('export refuses a legacy catalog asset without a verified downloader receipt', async () => {
  const state = await fixture(false);
  await expect(exportMediaPackage(state.catalog, state.asset, state.manifest, state.store, state.parent, preview))
    .rejects.toThrow(/verified download receipt/i);
  expect(existsSync(join(state.parent, 'Angel Engine Part 63 [abcdefghijk]'))).toBe(false);
});

test('concurrent exports to one package name publish once and preserve same-filesystem atomic staging', async () => {
  const state = await fixture();
  const results = await Promise.allSettled([
    exportMediaPackage(state.catalog, state.asset, state.manifest, state.store, state.parent, preview),
    exportMediaPackage(state.catalog, state.asset, state.manifest, state.store, state.parent, preview),
  ]);
  expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(item => item.status === 'rejected')).toHaveLength(1);
  const rejected = results.find(item => item.status === 'rejected') as PromiseRejectedResult;
  expect(rejected.reason).toBeInstanceOf(PackageCollisionError);
  const collision = rejected.reason as PackageCollisionError;
  if (collision.staged_directory) expect(existsSync(collision.staged_directory)).toBe(true);
  const published = (results.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
  expect(statSync(published.directory).dev).toBe(statSync(state.parent).dev);
});

test('publisher failure fails closed and preserves the partial package location', async () => {
  const state = await fixture();
  const publisher = async () => { throw Error('atomic no-replace unavailable'); };
  let failure: unknown;
  try {
    await exportMediaPackage(state.catalog, state.asset, state.manifest, state.store, state.parent, preview, { publisher });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PackageExportError);
  const partial = (failure as PackageExportError).partial_directory;
  expect(existsSync(partial)).toBe(true);
  expect(existsSync(join(partial, 'manifest.json'))).toBe(true);
  expect(existsSync(join(state.parent, 'Angel Engine Part 63 [abcdefghijk]'))).toBe(false);
});

test('post-publication verification failure reports the surviving final package path', async () => {
  const state = await fixture();
  const publisher = async (partial: string, final: string) => {
    renameSync(partial, final);
    writeFileSync(join(final, 'manifest.json'), 'tampered');
  };
  let failure: unknown;
  try {
    await exportMediaPackage(state.catalog, state.asset, state.manifest, state.store, state.parent, preview, { publisher });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PackageExportError);
  const preserved = (failure as PackageExportError).partial_directory;
  expect(preserved).toBe(join(state.parent, 'Angel Engine Part 63 [abcdefghijk]'));
  expect(existsSync(preserved)).toBe(true);
  expect(existsSync(join(preserved, 'manifest.json'))).toBe(true);
});
