import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const ASSET_ID = /^creative_[a-f0-9]{64}$/;

export type CreativeImageAsset = {
  id: string;
  kind: 'image';
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  sha256: string;
  name: string;
  created_at: string;
  provider: 'comfyui';
  job_id: string;
  workflow_id: string;
  workflow_sha256: string;
  output_index: number;
  file: string;
};

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function extension(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  throw Error('ComfyUI returned an unsupported image type');
}

function validMagic(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

export class CreativeAssetStore {
  private readonly assetsHome: string;

  constructor(home: string) {
    this.assetsHome = join(home, 'assets');
    mkdirSync(this.assetsHome, { recursive: true, mode: 0o700 });
  }

  addImage(bytes: Buffer, mimeType: string, source: { job_id: string; workflow_id: string; workflow_sha256: string; output_index: number }):
    CreativeImageAsset {
    if (bytes.length < 12 || bytes.length > MAX_IMAGE_BYTES) throw Error('ComfyUI image exceeds the local asset limit');
    if (!validMagic(bytes, mimeType)) throw Error('ComfyUI returned invalid image bytes');
    if (!Number.isInteger(source.output_index) || source.output_index < 0) throw Error('Invalid image output index');

    const sha256 = digest(bytes);
    const id = `creative_${digest(Buffer.from(`${source.job_id}\0${source.output_index}\0${sha256}`))}`;
    const file = `${id}${extension(mimeType)}`;
    const metadataPath = join(this.assetsHome, `${id}.json`);
    if (existsSync(metadataPath)) return this.read(id).asset;

    const asset: CreativeImageAsset = {
      id,
      kind: 'image',
      mime_type: mimeType as CreativeImageAsset['mime_type'],
      bytes: bytes.length,
      sha256,
      name: `generated-${source.output_index + 1}${extension(mimeType)}`,
      created_at: new Date().toISOString(),
      provider: 'comfyui',
      job_id: source.job_id,
      workflow_id: source.workflow_id,
      workflow_sha256: source.workflow_sha256,
      output_index: source.output_index,
      file,
    };
    const dataTemp = join(this.assetsHome, `${file}.${randomUUID()}.tmp`);
    const metadataTemp = join(this.assetsHome, `${id}.${randomUUID()}.tmp`);
    writeFileSync(dataTemp, bytes, { mode: 0o600, flag: 'wx' });
    renameSync(dataTemp, join(this.assetsHome, file));
    writeFileSync(metadataTemp, JSON.stringify(asset), { mode: 0o600, flag: 'wx' });
    renameSync(metadataTemp, metadataPath);
    return asset;
  }

  read(id: string): { asset: CreativeImageAsset; bytes: Buffer } {
    if (!ASSET_ID.test(id)) throw Error('Invalid creative asset ID');
    const metadataPath = join(this.assetsHome, `${id}.json`);
    const asset = JSON.parse(readFileSync(metadataPath, 'utf8')) as CreativeImageAsset;
    if (asset.id !== id || asset.kind !== 'image' || asset.file !== `${id}${extension(asset.mime_type)}`) throw Error('Creative asset metadata is invalid');
    if (extname(asset.file) !== extension(asset.mime_type)) throw Error('Creative asset metadata is invalid');
    const bytes = readFileSync(join(this.assetsHome, asset.file));
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256 || !validMagic(bytes, asset.mime_type)) throw Error(
      'Creative asset integrity check failed');
    return { asset, bytes };
  }
}
