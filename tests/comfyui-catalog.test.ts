import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyWorkflowCatalog } from '../src/comfyui/catalog';

test('workflow bindings produce a fresh ComfyUI graph with validated values and defaults', () => {
  const home = mkdtempSync(join(tmpdir(), 'isymcp-comfy-catalog-'));
  const source = join(home, 'workflow.json');
  writeFileSync(source, JSON.stringify({
    name: 'Configured image workflow',
    graph: {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'default prompt' } },
      '2': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, sampler_name: 'euler' } },
    },
    inputs: {
      prompt: { node_id: '1', field: 'text', type: 'string', required: true },
      seed: { node_id: '2', field: 'seed', type: 'integer', min: 0, max: 9999, default: 7 },
      sampler: { node_id: '2', field: 'sampler_name', type: 'enum', options: ['euler', 'dpmpp'], default: 'euler' },
    },
  }));
  const catalog = new ComfyWorkflowCatalog(join(home, 'state'));
  const workflow = catalog.add(source);

  const prompt = catalog.buildPrompt(workflow.id, { prompt: 'an orange cat', seed: 42 });
  expect(prompt['1'].inputs.text).toBe('an orange cat');
  expect(prompt['2'].inputs.seed).toBe(42);
  expect(prompt['2'].inputs.sampler_name).toBe('euler');
  expect(catalog.buildPrompt(workflow.id, { prompt: 'another cat' })['2'].inputs.seed).toBe(7);

  expect(() => catalog.buildPrompt(workflow.id, { prompt: 'cat', unsupported: true })).toThrow('Unknown workflow input');
  expect(() => catalog.buildPrompt(workflow.id, { prompt: 'cat', seed: 10_000 })).toThrow('configured range');
  expect(() => catalog.buildPrompt(workflow.id, { prompt: 'cat', sampler: 'unknown' })).toThrow('Invalid value');
});
