import { test, expect } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintArtifact, MediaPreparationStore } from '../src/media/preparation-store';
import { MediaCatalog } from '../src/media/catalog';

const assetId = 'media_00000000-0000-4000-8000-000000000001';
const sourceUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
const sourceHash = 'a'.repeat(64);
const tempHome = () => mkdtempSync(join(tmpdir(), 'isymcp-preparation-'));

test('artifact fingerprints are stable and include the artifact inputs', () => {
  const first = fingerprintArtifact('audio_scan', sourceHash, { chunk_seconds: 120 }, 'audio-rms-activity/2');
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprintArtifact('audio_scan', sourceHash, { chunk_seconds: 120 }, 'audio-rms-activity/2')).toBe(first);
  expect(fingerprintArtifact('audio_scan', sourceHash, { chunk_seconds: 60 }, 'audio-rms-activity/2')).not.toBe(first);
  expect(fingerprintArtifact('contact_sheet', sourceHash, { chunk_seconds: 120 }, 'audio-rms-activity/2')).not.toBe(first);
});

test('store writes private generation and artifact files and reads verified bytes', () => {
  const root = tempHome();
  const store = new MediaPreparationStore(root);
  const generation = store.begin(assetId, sourceUrl, sourceHash);
  const artifact = store.recordArtifact(assetId, generation.generation_id, {
    id: 'audio-scan', kind: 'audio_scan', fingerprint: 'b'.repeat(64), algorithm_version: 'audio-rms-activity/2',
    parameters: { chunk_seconds: 120 }, time_range: { start_seconds: 0, end_seconds: 10 },
  }, Buffer.from('{"chunks":[]}'));

  const preparationDir = join(root, 'preparations', assetId);
  const generationDir = join(preparationDir, 'generations', generation.generation_id);
  expect(statSync(preparationDir).mode & 0o777).toBe(0o700);
  expect(statSync(generationDir).mode & 0o777).toBe(0o700);
  expect(statSync(join(generationDir, artifact.filename)).mode & 0o777).toBe(0o600);
  expect(statSync(join(generationDir, 'manifest.json')).mode & 0o777).toBe(0o600);
  expect(store.readArtifact(assetId, generation.generation_id, artifact.id).toString()).toBe('{"chunks":[]}');
});

test('ready pointer changes only after a generation is ready and failed publication preserves it', () => {
  const store = new MediaPreparationStore(tempHome());
  const first = store.begin(assetId, sourceUrl, sourceHash);
  store.setStatus(assetId, first.generation_id, 'ready', { phase: 'complete' });
  store.commitReady(assetId, first.generation_id);
  expect(store.current(assetId)?.generation_id).toBe(first.generation_id);

  const next = store.begin(assetId, sourceUrl, 'c'.repeat(64));
  expect(() => store.commitReady(assetId, next.generation_id)).toThrow();
  expect(store.current(assetId)?.generation_id).toBe(first.generation_id);
});

test('matching incomplete generations resume while source changes start a new generation', () => {
  const store = new MediaPreparationStore(tempHome());
  const partial = store.begin(assetId, sourceUrl, sourceHash);
  store.setStatus(assetId, partial.generation_id, 'partial', { phase: 'contact_sheet', completed: 1, total: 2 });
  const retry = store.begin(assetId, sourceUrl, sourceHash);
  expect(retry.generation_id).toBe(partial.generation_id);
  const changed = store.begin(assetId, sourceUrl, 'd'.repeat(64));
  expect(changed.generation_id).not.toBe(partial.generation_id);
});

test('manifest and artifact tampering are rejected', () => {
  const root = tempHome();
  const store = new MediaPreparationStore(root);
  const generation = store.begin(assetId, sourceUrl, sourceHash);
  store.recordArtifact(assetId, generation.generation_id, {
    id: 'audio-scan', kind: 'audio_scan', fingerprint: 'e'.repeat(64), algorithm_version: 'audio-rms-activity/2',
    parameters: {}, time_range: { start_seconds: 0, end_seconds: 1 },
  }, Buffer.from('trusted'));
  store.setStatus(assetId, generation.generation_id, 'ready', { phase: 'complete' });
  store.commitReady(assetId, generation.generation_id);
  const generationDir = join(root, 'preparations', assetId, 'generations', generation.generation_id);
  writeFileSync(join(generationDir, 'manifest.json'), '{"schema_version":"forged"}');
  expect(() => store.current(assetId)).toThrow();

  const artifactRoot = tempHome();
  const artifactStore = new MediaPreparationStore(artifactRoot);
  const second = artifactStore.begin(assetId, sourceUrl, 'f'.repeat(64));
  const secondArtifact = artifactStore.recordArtifact(assetId, second.generation_id, {
    id: 'sheet-0', kind: 'contact_sheet', fingerprint: '1'.repeat(64), algorithm_version: 'sheet/1',
    parameters: {}, time_range: { start_seconds: 0, end_seconds: 1 },
  }, Buffer.from('trusted'));
  writeFileSync(join(artifactRoot, 'preparations', assetId, 'generations', second.generation_id, secondArtifact.filename), 'tampered');
  expect(() => artifactStore.readArtifact(assetId, second.generation_id, secondArtifact.id)).toThrow();
});

test('asset IDs and artifact IDs cannot escape the preparation directory', () => {
  const store = new MediaPreparationStore(tempHome());
  expect(() => store.current('../outside')).toThrow('Invalid asset ID');
  expect(() => store.begin('media_../../outside', sourceUrl, sourceHash)).toThrow('Invalid asset ID');
  expect(() => store.readArtifact(assetId, 'generation/../../outside', 'artifact')).toThrow();
});

test('catalog URL lookup returns only exact active source matches', async () => {
  const root = tempHome();
  const catalog = new MediaCatalog(join(root, 'catalog'));
  const media = join(root, 'sample.wav');
  writeFileSync(media, 'audio');
  const active = await catalog.add(media, sourceUrl);
  expect(catalog.findBySourceUrl(sourceUrl)?.id).toBe(active.id);
  expect(catalog.findBySourceUrl(`${sourceUrl}&list=playlist`)).toBeUndefined();
  catalog.revoke(active.id);
  expect(catalog.findBySourceUrl(sourceUrl)).toBeUndefined();
});
