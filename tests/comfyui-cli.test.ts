import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = join(import.meta.dir, '..');

function runCli(home: string, args: string[]) {
  return spawnSync(process.execPath, ['src/isymcp.ts', ...args], {
    cwd: root,
    env: { ...process.env, ISYMCP_COMFYUI_HOME: join(home, 'state') },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test('comfy workflow list returns an empty catalog without requiring ComfyUI to be running', () => {
  const home = mkdtempSync(join(tmpdir(), 'isymcp-comfy-cli-'));
  const result = runCli(home, ['comfy', 'workflow', 'list']);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ workflows: [] });
});

test('comfy workflow registration lists its ID and source hash without exposing its path', () => {
  const home = mkdtempSync(join(tmpdir(), 'isymcp-comfy-register-'));
  const source = join(home, 'api-workflow.json');
  const definition = JSON.stringify({
    name: 'Prompt to image',
    graph: {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } },
      '2': { class_type: 'SaveImage', inputs: { filename_prefix: 'isymcp', images: ['1', 0] } },
    },
    inputs: { prompt: { node_id: '1', field: 'text', type: 'string', required: true } },
  });
  writeFileSync(source, definition);

  const registered = runCli(home, ['comfy', 'workflow', 'add', source]);
  expect(registered.status).toBe(0);
  const receipt = JSON.parse(registered.stdout);
  expect(receipt).toMatchObject({ name: 'Prompt to image', sha256: createHash('sha256').update(definition).digest('hex') });
  expect(receipt.id).toMatch(/^workflow_[a-f0-9-]{36}$/);

  const listed = runCli(home, ['comfy', 'workflow', 'list']);
  expect(listed.status).toBe(0);
  expect(JSON.parse(listed.stdout)).toEqual({ workflows: [{ ...receipt, inputs: ['prompt'] }] });
  expect(listed.stdout).not.toContain(home);
});

test('comfy workflow registration rejects an input binding to a missing graph node', () => {
  const home = mkdtempSync(join(tmpdir(), 'isymcp-comfy-invalid-'));
  const source = join(home, 'invalid-workflow.json');
  writeFileSync(source, JSON.stringify({
    name: 'Broken workflow',
    graph: { '1': { class_type: 'SaveImage', inputs: {} } },
    inputs: { prompt: { node_id: '9', field: 'text', type: 'string' } },
  }));

  const result = runCli(home, ['comfy', 'workflow', 'add', source]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('does not exist');
  expect(result.stderr).not.toContain(home);
});
