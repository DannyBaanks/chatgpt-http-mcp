import { createReadStream } from 'node:fs';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { MediaCatalog, Asset, digest } from './catalog';
import { YouTubePreview } from './preview';
import { youtubeSource } from './importer';
import { PreparationManifest, MediaPreparationStore } from './preparation-store';
import { run } from './process';

export type PackageExportResult = { directory: string; manifest_path: string; manifest_sha256: string };

export class PackageCollisionError extends Error {
  constructor(public readonly directory: string) {
    super('A media package with this title already exists; choose another output folder');
    this.name = 'PackageCollisionError';
  }
}

export class PackageExportError extends Error {
  constructor(message: string, public readonly partial_directory: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PackageExportError';
  }
}

export type PackageExportOptions = {
  publisher?: (partial: string, final: string) => Promise<void>;
};

type ExportFile = { path: string; kind: 'source' | 'audio_scan' | 'contact_sheet'; bytes: number; sha256: string };

function safeDirectoryTitle(title: string | undefined): string {
  const clean = (title ?? '')
    .normalize('NFKC')
    .replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  if (!clean || clean === '.' || clean === '..') return 'video';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(clean) ? `_${clean}` : clean;
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

async function fileSha256(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function publishNoReplace(partial: string, final: string): Promise<void> {
  let failure: unknown;
  try {
    await run('mv', ['-T', '-n', '--', partial, final], 64 * 1024, 30000, {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/tmp', LANG: 'C.UTF-8' },
    });
  } catch (error) { failure = error; }
  if (pathExists(partial)) {
    if (pathExists(final)) throw new PackageCollisionError(final);
    throw Error('Atomic no-replace publisher failed; staged package remains available', { cause: failure });
  }
  if (!pathExists(final)) throw Error('Atomic no-replace publisher did not create the final package', { cause: failure });
}

function resolutionFrom(manifest: PreparationManifest): string | undefined {
  const stream = manifest.streams?.find(item => item.codec_type === 'video');
  const width = Number(stream?.width), height = Number(stream?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return `${Math.trunc(width)}x${Math.trunc(height)}`;
}

function comparison(preview: YouTubePreview, manifest: PreparationManifest): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (preview.duration_seconds !== undefined && manifest.duration_seconds !== undefined) {
    result.duration_delta_seconds = Number((manifest.duration_seconds - preview.duration_seconds).toFixed(3));
  }
  const actualResolution = resolutionFrom(manifest);
  if (preview.resolution !== undefined && actualResolution !== undefined) {
    result.preview_resolution = preview.resolution;
    result.downloaded_resolution = actualResolution;
    result.resolution_matches = preview.resolution === actualResolution;
  }
  return result;
}

export async function exportMediaPackage(
  catalog: MediaCatalog,
  asset: Asset,
  manifest: PreparationManifest,
  store: MediaPreparationStore,
  parentDirectory: string,
  preview: YouTubePreview,
  options: PackageExportOptions = {},
): Promise<PackageExportResult> {
  const canonicalUrl = youtubeSource(preview.url);
  const videoId = new URL(canonicalUrl).searchParams.get('v');
  if (canonicalUrl !== preview.url || videoId !== preview.video_id || asset.sourceUrl !== canonicalUrl) {
    throw Error('Media package source identity does not match the canonical YouTube URL');
  }
  if (manifest.status !== 'ready') throw Error('Media package requires a ready preparation');
  const current = store.current(asset.id);
  if (!current || current.generation_id !== manifest.generation_id || current.status !== 'ready') {
    throw Error('Media preparation is not the verified current generation');
  }
  const verifiedAsset = await catalog.resolve(asset.id);
  if (verifiedAsset.sha256 !== current.source_sha256 || verifiedAsset.sourceUrl !== canonicalUrl) {
    throw Error('Media package source failed catalog verification');
  }
  const downloadReceipt = verifiedAsset.downloadReceipt;
  if (!downloadReceipt || downloadReceipt.source_url !== canonicalUrl || downloadReceipt.video_id !== videoId) {
    throw Error('Media package requires a verified download receipt for this canonical video');
  }
  const parent = resolve(parentDirectory);
  if (!statSync(parent).isDirectory()) throw Error('Media package destination is not a directory');
  const extension = extname(verifiedAsset.realPath).toLowerCase();
  const packageName = `${safeDirectoryTitle(preview.title)} [${videoId}]`;
  const finalDirectory = join(parent, packageName);
  if (pathExists(finalDirectory)) throw new PackageCollisionError(finalDirectory);

  const partialDirectory = mkdtempSync(join(parent, '.isymcp-package-'));
  try {
    if (statSync(partialDirectory).dev !== statSync(parent).dev) throw Error('Package staging is not on the destination filesystem');
    mkdirSync(join(partialDirectory, 'audio-scan'));
    mkdirSync(join(partialDirectory, 'contact-sheets'));

    const files: ExportFile[] = [];
    const sourceRelative = `source${extension}`;
    const sourcePath = join(partialDirectory, sourceRelative);
    copyFileSync(verifiedAsset.realPath, sourcePath, constants.COPYFILE_EXCL);
    const copiedSource = await fileSha256(sourcePath);
    if (copiedSource.sha256 !== verifiedAsset.sha256 || copiedSource.bytes !== verifiedAsset.bytes) {
      throw Error('Copied media source failed SHA-256 verification');
    }
    files.push({ path: sourceRelative, kind: 'source', ...copiedSource });

    const preparedArtifacts = [];
    for (const artifact of current.artifacts) {
      const bytes = store.readArtifact(asset.id, current.generation_id, artifact.id);
      if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256) throw Error('Prepared artifact failed SHA-256 verification');
      const directory = artifact.kind === 'audio_scan' ? 'audio-scan' : 'contact-sheets';
      const relative = `${directory}/${artifact.id}.${artifact.kind === 'audio_scan' ? 'json' : 'jpg'}`;
      writeFileSync(join(partialDirectory, relative), bytes, { flag: 'wx', mode: 0o600 });
      files.push({ path: relative, kind: artifact.kind, bytes: bytes.length, sha256: digest(bytes) });
      preparedArtifacts.push({ ...artifact, export_path: relative });
    }

    const exportedManifest = {
      schema_version: 'isymcp-media-package/1',
      source: {
        asset_id: verifiedAsset.id,
        source_url: canonicalUrl,
        video_id: videoId,
        download_receipt: downloadReceipt,
        source_name: verifiedAsset.name,
        sha256: verifiedAsset.sha256,
        bytes: verifiedAsset.bytes,
        exported_as: sourceRelative,
      },
      preview,
      downloaded_media: {
        source_sha256: current.source_sha256,
        source_bytes: current.source_bytes,
        duration_seconds: current.duration_seconds,
        streams: current.streams ?? [],
      },
      preview_comparison: comparison(preview, current),
      preparation: {
        schema_version: current.schema_version,
        generation_id: current.generation_id,
        prepared_at: current.prepared_at,
        status: current.status,
        pipeline_versions: current.pipeline_versions ?? {},
        artifacts: preparedArtifacts,
      },
      contact_sheet_notice: 'Contact sheets contain ordered, timestamped sampled frames; they are not exhaustive frame extraction.',
      files,
    };
    const manifestBytes = Buffer.from(JSON.stringify(exportedManifest, null, 2) + '\n');
    const manifestPath = join(partialDirectory, 'manifest.json');
    writeFileSync(manifestPath, manifestBytes, { flag: 'wx', mode: 0o600 });
    const manifestHash = digest(manifestBytes);

    await (options.publisher ?? publishNoReplace)(partialDirectory, finalDirectory);
    if (!existsSync(finalDirectory) || pathExists(partialDirectory)) throw Error('Published package could not be verified');
    const finalManifestPath = join(finalDirectory, 'manifest.json');
    const finalManifestBytes = readFileSync(finalManifestPath);
    if (digest(finalManifestBytes) !== manifestHash) throw Error('Published package manifest failed SHA-256 verification');
    for (const file of files) {
      const copied = await fileSha256(join(finalDirectory, file.path));
      if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) throw Error('Published package artifact failed SHA-256 verification');
    }
    return { directory: finalDirectory, manifest_path: finalManifestPath, manifest_sha256: manifestHash };
  } catch (error) {
    if (error instanceof PackageCollisionError) throw error;
    throw new PackageExportError('Media package export failed; the private catalog is intact and the partial package was preserved', partialDirectory, {
      cause: error,
    });
  }
}
