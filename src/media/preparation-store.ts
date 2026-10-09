import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './catalog';

export type ArtifactKind = 'audio_scan' | 'contact_sheet';
export type PreparationStatus = 'preparing' | 'partial' | 'failed' | 'ready';
export type PreparationProgress = { phase: string; completed?: number; total?: number };
export type PreparationArtifact = {
  id: string;
  kind: ArtifactKind;
  filename: string;
  bytes: number;
  sha256: string;
  fingerprint: string;
  algorithm_version: string;
  parameters: unknown;
  time_range: { start_seconds: number; end_seconds: number };
};
export type PreparationManifest = {
  schema_version: 'isymcp-media-preparation/1';
  generation_id: string;
  asset_id: string;
  source_url: string;
  source_sha256: string;
  source_bytes?: number;
  prepared_at: string;
  updated_at: string;
  status: PreparationStatus;
  progress?: PreparationProgress;
  duration_seconds?: number;
  streams?: Array<Record<string, unknown>>;
  unavailable_modalities?: Array<'audio' | 'video'>;
  pipeline_versions?: Record<string, string>;
  artifacts: PreparationArtifact[];
};

const SCHEMA = 'isymcp-media-preparation/1' as const;
const assetPattern = /^media_[a-f0-9-]{36}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hashPattern = /^[a-f0-9]{64}$/;
const artifactIdPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw Error('Unsupported fingerprint parameter');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

export function fingerprintArtifact(kind: ArtifactKind, sourceSha256: string, parameters: unknown, algorithmVersion: string): string {
  if (!hashPattern.test(sourceSha256) || !algorithmVersion) throw Error('Invalid artifact fingerprint input');
  return createHash('sha256').update(stable({ kind, sourceSha256, parameters, algorithmVersion })).digest('hex');
}

function validateAssetId(assetId: string): void {
  if (!assetPattern.test(assetId)) throw Error('Invalid asset ID');
}
function validateGenerationId(generationId: string): void {
  if (!uuidPattern.test(generationId)) throw Error('Invalid generation ID');
}
function validateArtifactId(artifactId: string): void {
  if (!artifactIdPattern.test(artifactId)) throw Error('Invalid artifact ID');
}
function artifactFilename(artifact: Pick<PreparationArtifact, 'id' | 'kind'>): string {
  validateArtifactId(artifact.id);
  return `${artifact.id}.${artifact.kind === 'audio_scan' ? 'json' : 'jpg'}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class MediaPreparationStore {
  constructor(public readonly catalogHome: string) {}

  private prepRoot(create = false): string {
    const path = join(this.catalogHome, 'preparations');
    this.directory(path, create);
    return path;
  }
  private assetDir(assetId: string, create = false): string {
    validateAssetId(assetId);
    const path = join(this.prepRoot(create), assetId);
    this.directory(path, create);
    return path;
  }
  private generationsDir(assetId: string, create = false): string {
    const path = join(this.assetDir(assetId, create), 'generations');
    this.directory(path, create);
    return path;
  }
  private generationDir(assetId: string, generationId: string, create = false): string {
    validateGenerationId(generationId);
    const path = join(this.generationsDir(assetId, create), generationId);
    this.directory(path, create);
    return path;
  }
  private directory(path: string, create: boolean): void {
    if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) throw Error('Preparation generation not found');
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Invalid preparation directory');
    chmodSync(path, 0o700);
  }
  private atomicWrite(path: string, data: Buffer | string): void {
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
    try {
      renameSync(temp, path);
      chmodSync(path, 0o600);
    } catch (error) {
      // Keep failed writes as evidence for recovery; no cleanup is performed.
      throw error;
    }
  }
  private manifestPath(assetId: string, generationId: string): string {
    return join(this.generationDir(assetId, generationId), 'manifest.json');
  }
  private parseManifest(assetId: string, generationId: string, data = readFileSync(this.manifestPath(assetId, generationId))): PreparationManifest {
    let value: unknown;
    try { value = JSON.parse(data.toString('utf8')); } catch { throw Error('Invalid preparation manifest'); }
    if (!isRecord(value) || value.schema_version !== SCHEMA || value.asset_id !== assetId || value.generation_id !== generationId ||
      !hashPattern.test(String(value.source_sha256)) || typeof value.source_url !== 'string' ||
      !['preparing', 'partial', 'failed', 'ready'].includes(String(value.status)) || !Array.isArray(value.artifacts)) throw Error('Invalid preparation manifest');
    const ids = new Set<string>();
    for (const raw of value.artifacts) {
      if (!isRecord(raw) || !['audio_scan', 'contact_sheet'].includes(String(raw.kind)) || typeof raw.id !== 'string' ||
        !artifactIdPattern.test(raw.id) || ids.has(raw.id) || raw.filename !== artifactFilename(raw as unknown as Pick<PreparationArtifact, 'id' | 'kind'>) ||
        !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0 || !hashPattern.test(String(raw.sha256)) ||
        !hashPattern.test(String(raw.fingerprint)) || typeof raw.algorithm_version !== 'string' || !isRecord(raw.time_range) ||
        !Number.isFinite(raw.time_range.start_seconds) || !Number.isFinite(raw.time_range.end_seconds) ||
        Number(raw.time_range.start_seconds) < 0 || Number(raw.time_range.end_seconds) <= Number(raw.time_range.start_seconds)) throw Error('Invalid preparation manifest');
      ids.add(raw.id);
    }
    return value as unknown as PreparationManifest;
  }
  private writeManifest(assetId: string, manifest: PreparationManifest): void {
    const path = this.manifestPath(assetId, manifest.generation_id);
    this.atomicWrite(path, JSON.stringify(manifest));
  }
  private readCurrentPointer(assetId: string): { generation_id: string; manifest_sha256: string } | undefined {
    const file = join(this.assetDir(assetId), 'current.json');
    if (!existsSync(file)) return undefined;
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Invalid preparation pointer');
    let pointer: unknown;
    try { pointer = JSON.parse(readFileSync(file, 'utf8')); } catch { throw Error('Invalid preparation pointer'); }
    if (!isRecord(pointer) || typeof pointer.generation_id !== 'string' || !uuidPattern.test(pointer.generation_id) || !hashPattern.test(String(pointer.manifest_sha256))) throw Error('Invalid preparation pointer');
    return pointer as { generation_id: string; manifest_sha256: string };
  }

  current(assetId: string): PreparationManifest | undefined {
    validateAssetId(assetId);
    if (!existsSync(join(this.catalogHome, 'preparations', assetId))) return undefined;
    const pointer = this.readCurrentPointer(assetId);
    if (!pointer) return undefined;
    const data = readFileSync(this.manifestPath(assetId, pointer.generation_id));
    if (digest(data) !== pointer.manifest_sha256) throw Error('Preparation manifest integrity check failed');
    const manifest = this.parseManifest(assetId, pointer.generation_id, data);
    if (manifest.status !== 'ready') throw Error('Invalid preparation pointer');
    for (const artifact of manifest.artifacts) this.readArtifact(assetId, manifest.generation_id, artifact.id);
    return manifest;
  }

  begin(assetId: string, sourceUrl: string, sourceSha256: string, sourceBytes?: number, forceNew = false): PreparationManifest {
    validateAssetId(assetId);
    if (!hashPattern.test(sourceSha256) || !sourceUrl.startsWith('https://') || (sourceBytes !== undefined && (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0))) throw Error('Invalid preparation source');
    const current = this.current(assetId);
    if (!forceNew && current?.source_url === sourceUrl && current.source_sha256 === sourceSha256) return current;
    const generations = this.generationsDir(assetId, true);
    const candidates = readdirSync(generations).filter(name => uuidPattern.test(name)).sort().reverse();
    for (const generationId of candidates) {
      try {
        const manifest = this.parseManifest(assetId, generationId);
        if (manifest.source_url === sourceUrl && manifest.source_sha256 === sourceSha256 && manifest.status !== 'ready') return manifest;
      } catch { /* A malformed generation is preserved and never resumed. */ }
    }
    const generationId = randomUUID();
    const now = new Date().toISOString();
    const manifest: PreparationManifest = {
      schema_version: SCHEMA, generation_id: generationId, asset_id: assetId, source_url: sourceUrl,
      source_sha256: sourceSha256, source_bytes: sourceBytes, prepared_at: now, updated_at: now,
      status: 'preparing', progress: { phase: 'queued' }, artifacts: [],
    };
    this.generationDir(assetId, generationId, true);
    this.writeManifest(assetId, manifest);
    return manifest;
  }

  updateMetadata(assetId: string, generationId: string, metadata: Pick<PreparationManifest, 'source_bytes' | 'duration_seconds' | 'streams' | 'unavailable_modalities' | 'pipeline_versions'>): PreparationManifest {
    const manifest = this.parseManifest(assetId, generationId);
    Object.assign(manifest, metadata);
    manifest.updated_at = new Date().toISOString();
    this.writeManifest(assetId, manifest);
    return manifest;
  }

  recordArtifact(assetId: string, generationId: string, artifact: Omit<PreparationArtifact, 'filename' | 'bytes' | 'sha256'>, data: Buffer): PreparationArtifact {
    validateAssetId(assetId); validateGenerationId(generationId); validateArtifactId(artifact.id);
    if (!['audio_scan', 'contact_sheet'].includes(artifact.kind) || !hashPattern.test(artifact.fingerprint) || !artifact.algorithm_version ||
      !Number.isFinite(artifact.time_range.start_seconds) || !Number.isFinite(artifact.time_range.end_seconds) ||
      artifact.time_range.start_seconds < 0 || artifact.time_range.end_seconds <= artifact.time_range.start_seconds || !Buffer.isBuffer(data)) throw Error('Invalid preparation artifact');
    const manifest = this.parseManifest(assetId, generationId);
    const filename = artifactFilename(artifact);
    const complete: PreparationArtifact = { ...artifact, filename, bytes: data.length, sha256: digest(data) };
    const path = join(this.generationDir(assetId, generationId), filename);
    this.atomicWrite(path, data);
    manifest.artifacts = [...manifest.artifacts.filter(item => item.id !== artifact.id), complete];
    manifest.updated_at = new Date().toISOString();
    this.writeManifest(assetId, manifest);
    return complete;
  }

  setStatus(assetId: string, generationId: string, status: PreparationStatus, progress?: PreparationProgress): PreparationManifest {
    const manifest = this.parseManifest(assetId, generationId);
    manifest.status = status; manifest.progress = progress; manifest.updated_at = new Date().toISOString();
    this.writeManifest(assetId, manifest);
    return manifest;
  }

  commitReady(assetId: string, generationId: string): void {
    validateAssetId(assetId); validateGenerationId(generationId);
    const manifest = this.parseManifest(assetId, generationId);
    if (manifest.status !== 'ready') throw Error('Preparation generation is not ready');
    for (const artifact of manifest.artifacts) this.readArtifact(assetId, generationId, artifact.id);
    const data = readFileSync(this.manifestPath(assetId, generationId));
    this.atomicWrite(join(this.assetDir(assetId, true), 'current.json'), JSON.stringify({ generation_id: generationId, manifest_sha256: digest(data) }));
  }

  readArtifact(assetId: string, generationId: string, artifactId: string): Buffer {
    validateAssetId(assetId); validateGenerationId(generationId); validateArtifactId(artifactId);
    const manifest = this.parseManifest(assetId, generationId);
    const artifact = manifest.artifacts.find(item => item.id === artifactId);
    if (!artifact) throw Error('Preparation artifact not found');
    const path = join(this.generationDir(assetId, generationId), artifactFilename(artifact));
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Invalid preparation artifact');
    const data = readFileSync(path);
    if (data.length !== artifact.bytes || digest(data) !== artifact.sha256) throw Error('Preparation artifact integrity check failed');
    return data;
  }
}
