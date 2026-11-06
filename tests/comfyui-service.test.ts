import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyService } from '../src/comfyui/service';

function payload(result: any) {
  return JSON.parse(result.content.find((item: any) => item.type === 'text').text);
}

function workflowFile(directory: string): string {
  const file = join(directory, 'workflow.json');
  writeFileSync(file, JSON.stringify({ name: 'Image workflow', graph: { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'test' } } }, inputs: {} }));
  return file;
}

test('ComfyUI endpoint rejects non-loopback hosts before making a request', async () => {
  let requests = 0;
  const service = new ComfyService({
    home: join(mkdtempSync(join(tmpdir(), 'isymcp-comfy-url-')), 'state'),
    env: { ISYMCP_COMFYUI_URL: 'https://example.com' },
    fetcher: (async () => { requests += 1; return Response.json({}); }) as unknown as typeof fetch,
  });

  expect(payload(await service.call('comfyui_status', {}))).toMatchObject({ available: false });
  expect(requests).toBe(0);
});

test('a completed ComfyUI workflow with no image output fails instead of staying queued', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'isymcp-comfy-empty-'));
  let promptId = '';
  const service = new ComfyService({
    home: join(directory, 'state'),
    env: { ISYMCP_COMFYUI_URL: 'http://127.0.0.1:8188' },
    fetcher: (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/prompt') {
        promptId = 'completed-without-images';
        return Response.json({ prompt_id: promptId });
      }
      if (url.pathname === `/history/${promptId}`) {
        return Response.json({ [promptId]: { outputs: {} } });
      }
      if (url.pathname === '/queue') return Response.json({ queue_pending: [], queue_running: [] });
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  });
  const registered = service.workflows.add(workflowFile(directory));
  const queued = payload(await service.call('comfyui_generate', { workflow_id: registered.id }));
  const completed = await service.call('comfyui_job_status', { job_id: queued.job_id });

  expect(completed.isError).toBe(true);
  expect(payload(completed)).toMatchObject({ state: 'failed', error_code: 'comfyui_no_image_output' });
});

test('an invalid ComfyUI image is recorded as a failed job instead of being retried forever', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'isymcp-comfy-invalid-image-'));
  let promptId = '';
  let imageRequests = 0;
  const service = new ComfyService({
    home: join(directory, 'state'),
    env: { ISYMCP_COMFYUI_URL: 'http://127.0.0.1:8188' },
    fetcher: (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/prompt') {
        promptId = 'bad-image-output';
        return Response.json({ prompt_id: promptId });
      }
      if (url.pathname === `/history/${promptId}`) {
        return Response.json({ [promptId]: { status: { status_str: 'success', completed: true }, outputs: { '1': { images: [{ filename: 'bad.png', subfolder: '', type: 'output' }] } } } });
      }
      if (url.pathname === '/view') {
        imageRequests += 1;
        return new Response('not an image', { headers: { 'content-type': 'image/png' } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  });
  const registered = service.workflows.add(workflowFile(directory));
  const queued = payload(await service.call('comfyui_generate', { workflow_id: registered.id }));
  const failed = await service.call('comfyui_job_status', { job_id: queued.job_id });
  const repeated = await service.call('comfyui_job_status', { job_id: queued.job_id });

  expect(payload(failed)).toMatchObject({ state: 'failed', error_code: 'comfyui_output_unavailable' });
  expect(payload(repeated)).toMatchObject({ state: 'failed', error_code: 'comfyui_output_unavailable' });
  expect(imageRequests).toBe(1);
});
