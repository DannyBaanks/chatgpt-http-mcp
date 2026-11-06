import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(import.meta.dir, '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8X8AAAAASUVORK5CYII=', 'base64');

function textPayload(result: any) {
  const text = result.content.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP tool returned no text payload');
  return JSON.parse(text) as Record<string, any>;
}

test('ComfyUI MCP queues a configured workflow and returns a verified image asset', async () => {
  let submittedPrompt: Record<string, any> | undefined;
  let promptId = '';
  const comfy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/system_stats') {
        return Response.json({ system: { comfyui_version: '0.3.0-test' }, devices: [] });
      }
      if (url.pathname === '/prompt' && request.method === 'POST') {
        const payload = await request.json() as { prompt?: Record<string, any> };
        submittedPrompt = payload.prompt;
        promptId = 'test-prompt-1';
        return Response.json({ prompt_id: promptId });
      }
      if (url.pathname === `/history/${promptId}` && promptId) {
        return Response.json({ [promptId]: { outputs: { '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } } });
      }
      if (url.pathname === '/view') return new Response(png, { headers: { 'content-type': 'image/png' } });
      return new Response('not found', { status: 404 });
    },
  });

  const home = mkdtempSync(join(tmpdir(), 'isymcp-comfy-mcp-'));
  const state = join(home, 'state');
  const workflowPath = join(home, 'workflow.json');
  writeFileSync(workflowPath, JSON.stringify({
    name: 'Prompt to image',
    graph: {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } },
      '2': { class_type: 'SaveImage', inputs: { filename_prefix: 'isymcp', images: ['1', 0] } },
    },
    inputs: { prompt: { node_id: '1', field: 'text', type: 'string', required: true } },
  }));
  const registered = spawnSync(process.execPath, ['src/isymcp.ts', 'comfy', 'workflow', 'add', workflowPath], {
    cwd: root,
    env: { ...process.env, ISYMCP_COMFYUI_HOME: state },
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(registered.status).toBe(0);
  const workflow = JSON.parse(registered.stdout) as { id: string };

  const client = new Client({ name: 'comfyui-smoke', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'src/mcp/media.ts')],
    env: { ...process.env, ISYMCP_COMFYUI_HOME: state, ISYMCP_COMFYUI_URL: comfy.url.toString() } as Record<string, string>,
  });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('comfyui_status');
    expect(names).toContain('comfyui_workflows');
    expect(names).toContain('comfyui_generate');
    expect(names).toContain('comfyui_job_status');
    expect(names).toContain('creative_asset_get');

    const status = textPayload(await client.callTool({ name: 'comfyui_status', arguments: {} } as any));
    expect(status).toMatchObject({ available: true, version: '0.3.0-test' });
    const queued = textPayload(await client.callTool({ name: 'comfyui_generate', arguments: { workflow_id: workflow.id, inputs: { prompt: 'a small orange cat' } } } as any));
    expect(queued.state).toBe('queued');

    const complete = textPayload(await client.callTool({ name: 'comfyui_job_status', arguments: { job_id: queued.job_id } } as any));
    expect(complete.state).toBe('completed');
    expect(complete.assets).toHaveLength(1);
    expect(submittedPrompt?.['1'].inputs.text).toBe('a small orange cat');

    const asset = await client.callTool({ name: 'creative_asset_get', arguments: { asset_id: complete.assets[0].id } } as any);
    expect(asset.isError).not.toBe(true);
    expect(textPayload(asset as any)).toMatchObject({ id: complete.assets[0].id, kind: 'image', mime_type: 'image/png' });
    const image = (asset as any).content.find((item: any) => item.type === 'image') as { data: string; mimeType: string } | undefined;
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image!.data, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(JSON.stringify([status, queued, complete, asset])).not.toContain(home);
  } finally {
    await client.close();
    comfy.stop(true);
  }
}, 20_000);
