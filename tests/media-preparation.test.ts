import { test, expect } from 'bun:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaCatalog } from '../src/media/catalog';
import { MediaPreparationStore } from '../src/media/preparation-store';
import { prepareMedia } from '../src/media/preparation';
import { run } from '../src/media/process';

const sourceUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
const root = () => mkdtempSync(join(tmpdir(), 'isymcp-prepare-'));

async function fixture(path: string, video: boolean, audio: boolean, seconds: number) {
  const args = ['-v', 'error', '-y'];
  if (video) args.push('-f', 'lavfi', '-i', `color=c=red:s=128x72:r=8:d=${seconds}`);
  if (audio) args.push('-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono:d=${seconds}`);
  if (video && audio) args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', 'mpeg4', '-q:v', '31', '-c:a', 'aac', '-shortest');
  else if (video) args.push('-c:v', 'mpeg4', '-q:v', '31');
  else args.push('-c:a', 'pcm_s16le');
  args.push(path);
  await run('ffmpeg', args, 1024 * 1024, 30000);
}

async function prepare(path: string, home: string, onProgress?: (phase: string, completed?: number, total?: number) => void) {
  const catalog = new MediaCatalog(home);
  const asset = catalog.findBySourceUrl(sourceUrl) ?? await catalog.add(path, sourceUrl);
  const store = new MediaPreparationStore(catalog.home);
  return { catalog, asset, store, manifest: await prepareMedia(catalog, asset, store, { onProgress }) };
}

// This integration test generates a real 121-second FFmpeg fixture and renders three
// contact sheets; CI runners can exceed Bun's default 5s per-test timeout.
test('preparation covers a 121-second audio/video source in bounded chunks and reuses a ready generation', async () => {
  const base = root(), path = join(base, 'source.mp4'), home = join(base, 'catalog');
  await fixture(path, true, true, 121);
  const events: string[] = [];
  const first = await prepare(path, home, phase => events.push(phase));
  expect(first.manifest.status).toBe('ready');
  expect(first.manifest.duration_seconds).toBeCloseTo(121, 0);
  const audio = first.manifest.artifacts.find(artifact => artifact.kind === 'audio_scan')!;
  const scan = JSON.parse(first.store.readArtifact(first.asset.id, first.manifest.generation_id, audio.id).toString());
  expect(scan.chunks.map((chunk: any) => [chunk.start_seconds, chunk.end_seconds])).toEqual([[0, 120], [120, 121]]);
  expect(scan.chunks.every((chunk: any) => chunk.end_seconds - chunk.start_seconds <= 120)).toBe(true);
  const sheets = first.manifest.artifacts.filter(artifact => artifact.kind === 'contact_sheet');
  expect(sheets.map(sheet => [sheet.time_range.start_seconds, sheet.time_range.end_seconds])).toEqual([[0, 60], [60, 120], [120, 121]]);
  expect(sheets.every(sheet => sheet.time_range.end_seconds - sheet.time_range.start_seconds <= 60)).toBe(true);
  const sheetInfo = sheets.map(sheet => sheet.parameters as any);
  expect(sheetInfo.every(info => info.samples.length === 16)).toBe(true);
  expect(events).toContain('audio_scan');

  const repeated: string[] = [];
  const second = await prepare(path, home, phase => repeated.push(phase));
  expect(second.manifest.generation_id).toBe(first.manifest.generation_id);
  expect(repeated).toEqual([]);

  const current = first.store.current(first.asset.id)!;
  const savedAudio = current.artifacts.find(artifact => artifact.kind === 'audio_scan')!;
  first.store.recordArtifact(first.asset.id, current.generation_id, {
    id: savedAudio.id, kind: savedAudio.kind, fingerprint: '0'.repeat(64), algorithm_version: 'audio-rms-activity/1',
    parameters: savedAudio.parameters, time_range: savedAudio.time_range,
  }, first.store.readArtifact(first.asset.id, current.generation_id, savedAudio.id));
  first.store.setStatus(first.asset.id, current.generation_id, 'ready', { phase: 'complete' });
  first.store.commitReady(first.asset.id, current.generation_id);
  await expect(prepareMedia(first.catalog, first.asset, first.store, {
    onProgress(phase) { if (phase === 'audio_scan') throw Error('injected analysis interruption'); },
  })).rejects.toThrow('injected analysis interruption');
  expect(first.store.current(first.asset.id)?.generation_id).toBe(current.generation_id);
  const resumedPhases: string[] = [];
  const refreshed = await prepareMedia(first.catalog, first.asset, first.store, { onProgress: phase => resumedPhases.push(phase) });
  expect(refreshed.status).toBe('ready');
  expect(refreshed.generation_id).not.toBe(current.generation_id);
  expect(resumedPhases).toContain('audio_scan');
  expect(resumedPhases.filter(phase => phase === 'contact_sheet_reused')).toHaveLength(3);
}, 30_000);

test('failed preparation resumes verified saved pages without publishing a partial generation', async () => {
  const base = root(), path = join(base, 'source.mp4'), home = join(base, 'catalog');
  await fixture(path, true, true, 61);
  const catalog = new MediaCatalog(home), asset = await catalog.add(path, sourceUrl);
  const store = new MediaPreparationStore(catalog.home);
  await expect(prepareMedia(catalog, asset, store, {
    onProgress(phase, completed) {
      if (phase === 'contact_sheet' && completed === 1) throw Error('injected interruption');
    },
  })).rejects.toThrow('injected interruption');
  expect(store.current(asset.id)).toBeUndefined();
  const partial = store.begin(asset.id, sourceUrl, asset.sha256);
  const firstPage = partial.artifacts.find(item => item.id === 'sheet-000')!;
  const pagePath = join(home, 'preparations', asset.id, 'generations', partial.generation_id, firstPage.filename);
  const mtime = statSync(pagePath).mtimeMs;
  const resumed: string[] = [];
  const result = await prepareMedia(catalog, asset, store, { onProgress: phase => resumed.push(phase) });
  expect(result.status).toBe('ready');
  expect(result.generation_id).toBe(partial.generation_id);
  expect(statSync(pagePath).mtimeMs).toBe(mtime);
  expect(resumed).toContain('contact_sheet_reused');
});

test('audio-only and video-only sources mark the absent modality unavailable', async () => {
  const base = root(), audioPath = join(base, 'audio.wav'), videoPath = join(base, 'video.mp4');
  await fixture(audioPath, false, true, 2);
  const audioOnly = await prepare(audioPath, join(base, 'audio-catalog'));
  expect(audioOnly.manifest.unavailable_modalities).toEqual(['video']);
  expect(audioOnly.manifest.artifacts.map(artifact => artifact.kind)).toEqual(['audio_scan']);

  await fixture(videoPath, true, false, 2);
  const videoOnly = await prepare(videoPath, join(base, 'video-catalog'));
  expect(videoOnly.manifest.unavailable_modalities).toEqual(['audio']);
  expect(videoOnly.manifest.artifacts.map(artifact => artifact.kind)).toEqual(['contact_sheet']);
});
