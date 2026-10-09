import { MediaCatalog, type Asset } from './catalog';
import { audioScan, probe } from './audio';
import { contactSheet } from './contact-sheet';
import { youtubeSource } from './importer';
import { fingerprintArtifact, MediaPreparationStore, type PreparationArtifact, type PreparationManifest } from './preparation-store';

const AUDIO_PARAMETERS = { chunkSeconds: 120, thresholdDbfs: -32, mergeGapSeconds: 0.1, minSegmentSeconds: 0.12, resolutionSeconds: 0.01 };
const AUDIO_VERSION = 'audio-rms-activity/2';
const SHEET_PARAMETERS = { columns: 4, width: 1920, height: 1080, qualityLimitBytes: 1024 * 1024 };
const SHEET_VERSION = 'contact-sheet-renderer/1';

type Progress = (phase: string, completed?: number, total?: number) => void;

function ranges(duration: number, seconds: number): Array<{ start_seconds: number; end_seconds: number }> {
  const out: Array<{ start_seconds: number; end_seconds: number }> = [];
  for (let start = 0; start < duration;) {
    const end = Math.min(duration, start + seconds);
    if (!(end > start)) throw Error('Invalid media duration');
    out.push({ start_seconds: start, end_seconds: end });
    start = end;
  }
  return out;
}

function audioFingerprint(sourceHash: string): string {
  return fingerprintArtifact('audio_scan', sourceHash, AUDIO_PARAMETERS, AUDIO_VERSION);
}

function sheetFingerprint(sourceHash: string, index: number, range: { start_seconds: number; end_seconds: number }): string {
  return fingerprintArtifact('contact_sheet', sourceHash, { ...SHEET_PARAMETERS, page_index: index, ...range }, SHEET_VERSION);
}

function cloneArtifact(store: MediaPreparationStore, target: PreparationManifest, candidates: PreparationManifest[], id: string, kind: PreparationArtifact['kind'], fingerprint: string): boolean {
  for (const candidate of candidates) {
    const cached = candidate.artifacts.find(item => item.id === id && item.kind === kind && item.fingerprint === fingerprint);
    if (!cached) continue;
    try {
      const data = store.readArtifact(candidate.asset_id, candidate.generation_id, cached.id);
      if (candidate.generation_id !== target.generation_id) {
        store.recordArtifact(target.asset_id, target.generation_id, {
          id: cached.id, kind: cached.kind, fingerprint: cached.fingerprint, algorithm_version: cached.algorithm_version,
          parameters: cached.parameters, time_range: cached.time_range,
        }, data);
      }
      return true;
    } catch { /* A damaged cache entry is ignored and regenerated. */ }
  }
  return false;
}

function sameReady(manifest: PreparationManifest | undefined, source: Asset, duration: number, hasAudio: boolean, hasVideo: boolean, pages: Array<{ start_seconds: number; end_seconds: number }>): boolean {
  if (!manifest || manifest.status !== 'ready' || manifest.source_sha256 !== source.sha256 || manifest.source_url !== source.sourceUrl ||
      manifest.duration_seconds !== duration) return false;
  const expected = (hasAudio ? 1 : 0) + pages.length;
  if (manifest.artifacts.length !== expected) return false;
  if (hasAudio && !manifest.artifacts.some(item => item.id === 'audio-scan' && item.kind === 'audio_scan' && item.fingerprint === audioFingerprint(source.sha256))) return false;
  if (pages.some((range, index) => !manifest.artifacts.some(item => item.id === `sheet-${String(index).padStart(3, '0')}` && item.kind === 'contact_sheet' && item.fingerprint === sheetFingerprint(source.sha256, index, range)))) return false;
  return manifest.unavailable_modalities?.includes('audio') === !hasAudio && manifest.unavailable_modalities?.includes('video') === !hasVideo;
}

export async function prepareMedia(
  catalog: MediaCatalog,
  asset: Asset,
  store: MediaPreparationStore,
  options: { onProgress?: Progress } = {},
): Promise<PreparationManifest> {
  if (!asset.sourceUrl || youtubeSource(asset.sourceUrl) !== asset.sourceUrl) throw Error('Preparation requires a registered public YouTube source URL');
  let generation: PreparationManifest | undefined;
  let phase = 'snapshot';
  let published = false;
  const progress = options.onProgress;
  try {
    const cached = store.current(asset.id);
    if (cached?.source_url === asset.sourceUrl && cached.source_sha256 === asset.sha256 && Number.isFinite(cached.duration_seconds) && cached.streams) {
      const hasAudio = cached.streams.some(stream => stream.codec_type === 'audio');
      const hasVideo = cached.streams.some(stream => stream.codec_type === 'video');
      const pages = hasVideo ? ranges(cached.duration_seconds!, 60) : [];
      if (sameReady(cached, asset, cached.duration_seconds!, hasAudio, hasVideo, pages)) {
        return await catalog.snapshot(asset.id, async () => cached);
      }
    }
    const prepared = await catalog.snapshot(asset.id, async (verifiedAsset, path) => {
      phase = 'metadata';
      progress?.(phase);
      const info = await probe(path);
      const hasAudio = info.streams.some(stream => stream.codec_type === 'audio');
      const hasVideo = info.streams.some(stream => stream.codec_type === 'video');
      if (!hasAudio && !hasVideo) throw Error('Media contains no supported audio or video stream');
      const pageRanges = hasVideo ? ranges(info.duration_seconds, 60) : [];
      const current = store.current(verifiedAsset.id);
      if (sameReady(current, verifiedAsset, info.duration_seconds, hasAudio, hasVideo, pageRanges)) return current!;

      generation = store.begin(verifiedAsset.id, verifiedAsset.sourceUrl!, verifiedAsset.sha256, verifiedAsset.bytes, Boolean(current));
      store.updateMetadata(verifiedAsset.id, generation.generation_id, {
        source_bytes: verifiedAsset.bytes, duration_seconds: info.duration_seconds, streams: info.streams,
        unavailable_modalities: [...(!hasAudio ? ['audio' as const] : []), ...(!hasVideo ? ['video' as const] : [])],
        pipeline_versions: { audio_scan: AUDIO_VERSION, contact_sheet: SHEET_VERSION },
      });

      const candidates = [generation, ...(current ? [current] : [])];
      if (hasAudio) {
        phase = 'audio_scan';
        const fingerprint = audioFingerprint(verifiedAsset.sha256);
        if (!cloneArtifact(store, generation, candidates, 'audio-scan', 'audio_scan', fingerprint)) {
          progress?.(phase);
          const result = await audioScan(path, 0, info.duration_seconds, 120, { thresholdDbfs: -32, mergeGapSeconds: 0.1, minSegmentSeconds: 0.12 });
          store.recordArtifact(verifiedAsset.id, generation.generation_id, {
            id: 'audio-scan', kind: 'audio_scan', fingerprint, algorithm_version: result.algorithm_version,
            parameters: result.parameters, time_range: result.window,
          }, Buffer.from(JSON.stringify(result)));
        } else progress?.('audio_scan_reused');
      }

      for (let index = 0; index < pageRanges.length; index++) {
        const range = pageRanges[index], id = `sheet-${String(index).padStart(3, '0')}`;
        const fingerprint = sheetFingerprint(verifiedAsset.sha256, index, range);
        if (cloneArtifact(store, generation, candidates, id, 'contact_sheet', fingerprint)) {
          progress?.('contact_sheet_reused', index + 1, pageRanges.length);
          continue;
        }
        phase = 'contact_sheet';
        const result = await contactSheet(path, range.start_seconds, range.end_seconds, 4);
        store.recordArtifact(verifiedAsset.id, generation.generation_id, {
          id, kind: 'contact_sheet', fingerprint, algorithm_version: SHEET_VERSION,
          parameters: { ...SHEET_PARAMETERS, samples: result.metadata.samples }, time_range: range,
        }, Buffer.from(result.image.data, 'base64'));
        progress?.(phase, index + 1, pageRanges.length);
      }

      phase = 'complete';
      store.setStatus(verifiedAsset.id, generation.generation_id, 'ready', { phase, completed: (hasAudio ? 1 : 0) + pageRanges.length, total: (hasAudio ? 1 : 0) + pageRanges.length });
      store.commitReady(verifiedAsset.id, generation.generation_id);
      published = true;
      progress?.(phase);
      return store.current(verifiedAsset.id)!;
    });
    return prepared;
  } catch (error) {
    if (generation && !published) {
      try { store.setStatus(generation.asset_id, generation.generation_id, 'failed', { phase }); } catch { /* Preserve the original failure and any earlier ready pointer. */ }
    }
    throw error;
  }
}
