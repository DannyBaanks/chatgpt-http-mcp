import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../media/process';
import { CreativeAssetStore, type CreativeImageAsset } from './assets';
import { ComfyWorkflowCatalog } from './catalog';

const JOB_ID = /^creativejob_[a-f0-9-]{36}$/;
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_IMAGES_PER_JOB = 16;

type JobState = 'submitting' | 'queued' | 'running' | 'completed' | 'failed';
type ComfyJob = {
  job_id: string;
  state: JobState;
  created_at: string;
  updated_at: string;
  provider_prompt_id: string;
  client_id: string;
  workflow_id: string;
  workflow_sha256: string;
  assets: Array<Pick<CreativeImageAsset, 'id' | 'name' | 'mime_type' | 'bytes' | 'sha256'>>;
  error_code?: string;
  message?: string;
};

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function imageMime(response: Response, filename: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  const header = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (header === 'image/png' || header === 'image/jpeg' || header === 'image/webp') return header;
  const extension = filename.toLowerCase().split('.').pop();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  return 'image/png';
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw Error('ComfyUI image exceeds the local asset limit');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw Error('ComfyUI image exceeds the local asset limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

export class ComfyService {
  readonly home: string;
  readonly workflows: ComfyWorkflowCatalog;
  private readonly assets: CreativeAssetStore;
  private readonly jobsHome: string;
  private readonly fetcher: typeof fetch;
  private readonly webSocket: typeof WebSocket;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: { home?: string; fetcher?: typeof fetch; webSocket?: typeof WebSocket; env?: NodeJS.ProcessEnv } = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? (this.env.ISYMCP_COMFYUI_HOME?.trim() || join(homedir(), '.local', 'state', 'isymcp', 'comfyui'));
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.jobsHome = join(this.home, 'jobs');
    mkdirSync(this.jobsHome, { recursive: true, mode: 0o700 });
    this.workflows = new ComfyWorkflowCatalog(this.home);
    this.assets = new CreativeAssetStore(this.home);
    this.fetcher = options.fetcher ?? fetch;
    this.webSocket = options.webSocket ?? WebSocket;
  }

  private baseUrl(): URL {
    const raw = this.env.ISYMCP_COMFYUI_URL?.trim() || 'http://127.0.0.1:8188';
    let url: URL;
    try { url = new URL(raw); }
    catch { throw Error('ComfyUI URL is invalid'); }
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    if (!['http:', 'https:'].includes(url.protocol) || !localHosts.has(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '')) {
      throw Error('ComfyUI must use a local HTTP endpoint without credentials or a URL path');
    }
    return url;
  }

  private endpoint(path: string): URL {
    const base = this.baseUrl();
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw Error('Invalid local ComfyUI endpoint');
    return url;
  }

  private async json(path: string, init: RequestInit = {}): Promise<any> {
    const response = await this.fetcher(this.endpoint(path), { ...init, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw Error(`ComfyUI request failed (${response.status})`);
    try { return await response.json(); }
    catch { throw Error('ComfyUI returned invalid JSON'); }
  }

  private jobFile(id: string): string {
    if (!JOB_ID.test(id)) throw Error('Invalid creative job ID');
    return join(this.jobsHome, `${id}.json`);
  }

  private saveJob(job: ComfyJob): void {
    const file = this.jobFile(job.job_id);
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(job), { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  }

  private getJob(id: string): ComfyJob {
    const job = JSON.parse(readFileSync(this.jobFile(id), 'utf8')) as ComfyJob;
    if (job.job_id !== id) throw Error('Creative job metadata is invalid');
    return job;
  }

  private publicJob(job: ComfyJob): Record<string, unknown> {
    return {
      job_id: job.job_id,
      state: job.state,
      workflow_id: job.workflow_id,
      workflow_sha256: job.workflow_sha256,
      assets: job.assets,
      ...(job.error_code ? { error_code: job.error_code } : {}),
      ...(job.message ? { message: job.message } : {}),
    };
  }

  private async waitForPrompt(job: ComfyJob, waitSeconds: number): Promise<void> {
    if (waitSeconds <= 0) return;
    const url = this.endpoint('/ws');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientId', job.client_id);
    await new Promise<void>((resolve) => {
      let settled = false;
      let socket: WebSocket;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closed */ }
        resolve();
      };
      const timer = setTimeout(finish, waitSeconds * 1000);
      try {
        socket = new this.webSocket(url.toString());
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const message = JSON.parse(event.data) as { type?: string; data?: { prompt_id?: string; node?: string | null } };
            if (message.type === 'executing' && message.data?.prompt_id === job.provider_prompt_id && message.data.node === null) finish();
          } catch { /* ignore non-JSON progress messages */ }
        });
        socket.addEventListener('error', finish, { once: true });
        socket.addEventListener('close', finish, { once: true });
      } catch { finish(); }
    });
  }

  private async history(job: ComfyJob): Promise<Record<string, any> | undefined> {
    const result = await this.json(`/history/${encodeURIComponent(job.provider_prompt_id)}`);
    if (!object(result)) return undefined;
    const entry = result[job.provider_prompt_id] ?? result;
    return object(entry) ? entry : undefined;
  }

  private async queueState(job: ComfyJob): Promise<'queued' | 'running'> {
    try {
      const queue = await this.json('/queue');
      const hasPrompt = (items: unknown) => Array.isArray(items) && items.some((item) => Array.isArray(item) && item[1] === job.provider_prompt_id);
      if (object(queue) && hasPrompt(queue.queue_pending)) return 'queued';
      if (object(queue) && hasPrompt(queue.queue_running)) return 'running';
    } catch { /* older ComfyUI builds may omit queue details */ }
    return job.state === 'submitting' ? 'queued' : job.state === 'queued' ? 'queued' : 'running';
  }

  private async finishJob(job: ComfyJob, entry: Record<string, any>): Promise<ComfyJob> {
    if (entry.status?.status_str === 'error') {
      job.state = 'failed';
      job.error_code = 'comfyui_execution_failed';
      job.message = 'ComfyUI could not complete this workflow; check its required nodes and models.';
      job.updated_at = new Date().toISOString();
      this.saveJob(job);
      return job;
    }
    const outputs = object(entry.outputs) ? Object.values(entry.outputs) : [];
    const images = outputs.flatMap((output: any) => Array.isArray(output?.images) ? output.images : []);
    if (!images.length) {
      job.state = 'failed';
      job.error_code = 'comfyui_no_image_output';
      job.message = 'ComfyUI finished the workflow without producing an image.';
      job.updated_at = new Date().toISOString();
      this.saveJob(job);
      return job;
    }
    if (images.length > MAX_IMAGES_PER_JOB) {
      job.state = 'failed';
      job.error_code = 'comfyui_output_limit';
      job.message = `Workflow produced more than ${MAX_IMAGES_PER_JOB} images; reduce its output batch.`;
      job.updated_at = new Date().toISOString();
      this.saveJob(job);
      return job;
    }
    const assets: ComfyJob['assets'] = [];
    for (const [index, image] of images.entries()) {
      if (!object(image) || typeof image.filename !== 'string' || image.filename.length > 512 || /[\u0000-\u001f\u007f]/.test(image.filename) ||
        typeof image.subfolder !== 'string' || image.subfolder.length > 512 || !['input', 'output', 'temp'].includes(image.type)) {
        throw Error('ComfyUI returned invalid image metadata');
      }
      const view = this.endpoint('/view');
      view.searchParams.set('filename', image.filename);
      view.searchParams.set('subfolder', image.subfolder);
      view.searchParams.set('type', image.type);
      const response = await this.fetcher(view, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw Error('ComfyUI image retrieval failed');
      const mimeType = imageMime(response, image.filename);
      const bytes = await readLimited(response, MAX_IMAGE_BYTES);
      const asset = this.assets.addImage(bytes, mimeType, {
        job_id: job.job_id,
        workflow_id: job.workflow_id,
        workflow_sha256: job.workflow_sha256,
        output_index: index,
      });
      assets.push({ id: asset.id, name: asset.name, mime_type: asset.mime_type, bytes: asset.bytes, sha256: asset.sha256 });
    }
    job.state = 'completed';
    job.assets = assets;
    job.updated_at = new Date().toISOString();
    this.saveJob(job);
    return job;
  }

  private async start(inputs: { workflow_id: string; inputs?: unknown }): Promise<Record<string, unknown>> {
    const workflow = this.workflows.get(inputs.workflow_id);
    const prompt = this.workflows.buildPrompt(inputs.workflow_id, inputs.inputs ?? {});
    const job: ComfyJob = {
      job_id: `creativejob_${randomUUID()}`,
      state: 'submitting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      provider_prompt_id: randomUUID(),
      client_id: randomUUID(),
      workflow_id: workflow.id,
      workflow_sha256: workflow.sha256,
      assets: [],
    };
    this.saveJob(job);
    try {
      const response = await this.json('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, client_id: job.client_id, prompt_id: job.provider_prompt_id }),
      });
      if (typeof response?.prompt_id !== 'string' || response.prompt_id.length > 128) throw Error('ComfyUI did not accept the workflow');
      job.provider_prompt_id = response.prompt_id;
      job.state = 'queued';
      job.updated_at = new Date().toISOString();
      this.saveJob(job);
      return this.publicJob(job);
    } catch {
      job.state = 'failed';
      job.error_code = 'comfyui_submit_failed';
      job.message = 'ComfyUI did not accept the workflow; check that the server and its required models are ready.';
      job.updated_at = new Date().toISOString();
      this.saveJob(job);
      throw Error(job.message);
    }
  }

  private async jobStatus(id: string, waitSeconds: number): Promise<Record<string, unknown>> {
    let job = this.getJob(id);
    if (job.state === 'completed' || job.state === 'failed') return this.publicJob(job);
    let entry = await this.history(job);
    if (!entry && waitSeconds > 0) {
      await this.waitForPrompt(job, waitSeconds);
      entry = await this.history(job);
    }
    if (entry) {
      try { job = await this.finishJob(job, entry); }
      catch {
        job.state = 'failed';
        job.error_code = 'comfyui_output_unavailable';
        job.message = 'ComfyUI finished, but its image output could not be verified or retrieved.';
        job.updated_at = new Date().toISOString();
        this.saveJob(job);
      }
    }
    if (job.state !== 'completed' && job.state !== 'failed') {
      job.state = await this.queueState(job);
      job.updated_at = new Date().toISOString();
      this.saveJob(job);
    }
    return this.publicJob(job);
  }

  private async getAsset(id: string): Promise<any> {
    const { asset, bytes } = this.assets.read(id);
    let preview: { type: 'image'; mimeType: string; data: string } | undefined;
    if (bytes.length <= 1024 * 1024) {
      preview = { type: 'image', mimeType: asset.mime_type, data: bytes.toString('base64') };
    } else {
      try {
        const jpeg = await run('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-frames:v', '1', '-f',
          'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', 'pipe:1'], 1024 * 1024, 15_000, { input: bytes });
        preview = { type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64') };
      } catch { /* return the local asset record even if no preview can be made */ }
    }
    const metadata = {
      id: asset.id,
      kind: asset.kind,
      mime_type: asset.mime_type,
      bytes: asset.bytes,
      sha256: asset.sha256,
      name: asset.name,
      created_at: asset.created_at,
      provider: asset.provider,
      job_id: asset.job_id,
      workflow_id: asset.workflow_id,
      workflow_sha256: asset.workflow_sha256,
      preview_available: Boolean(preview),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(metadata) }, ...(preview ? [preview] : [])] };
  }

  async call(name: string, args: any): Promise<any> {
    if (name === 'comfyui_workflows') return { content: [{ type: 'text' as const, text: JSON.stringify({ workflows: this.workflows.list() }) }] };
    if (name === 'comfyui_status') {
      try {
        const response = await this.json('/system_stats');
        return { content: [{ type: 'text' as const, text: JSON.stringify({ available: true, version: typeof response?.system?.comfyui_version === 'string' ?
          response.system.comfyui_version : 'unknown' }) }] };
      } catch {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ available: false, message:
          'ComfyUI is not reachable at the configured local endpoint.' }) }] };
      }
    }
    try {
      if (name === 'comfyui_generate') return { content: [{ type: 'text' as const, text: JSON.stringify(await this.start(args)) }] };
      if (name === 'comfyui_job_status') {
        const result = await this.jobStatus(args.job_id, args.wait_seconds ?? 0);
        return { isError: result.state === 'failed', content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      }
      if (name === 'creative_asset_get') return await this.getAsset(args.asset_id);
      throw Error('Unknown ComfyUI tool');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const code = raw.includes('Unknown workflow') || raw.includes('Invalid workflow') || raw.includes('Required workflow') || raw.includes('Workflow input')
        ? 'comfyui_invalid_workflow_input'
        : raw.includes('Creative asset') || raw.includes('Invalid creative asset') ? 'creative_asset_invalid'
        : raw.includes('Invalid creative job') || raw.includes('ENOENT') ? 'creative_job_not_found'
        : raw.includes('timed out') || raw.includes('abort') ? 'comfyui_timeout'
        : 'comfyui_operation_failed';
      const message = code === 'comfyui_invalid_workflow_input' ? raw
        : code === 'creative_asset_invalid' ? 'The image asset could not be verified.'
        : code === 'creative_job_not_found' ? 'The creative job or asset ID was not found.'
        : code === 'comfyui_timeout' ? 'ComfyUI did not finish the request before the local timeout.'
        : 'The ComfyUI operation failed; check the local service and its workflow configuration.';
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error_code: code, message }) }] };
    }
  }
}
