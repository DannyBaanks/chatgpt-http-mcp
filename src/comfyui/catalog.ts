import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

const MAX_WORKFLOW_BYTES = 10 * 1024 * 1024;
const WORKFLOW_ID = /^workflow_[a-f0-9-]{36}$/;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const INPUT_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'enum']);

export type WorkflowInputBinding = {
  node_id: string;
  field: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum';
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  options?: string[];
};

export type WorkflowBundle = {
  name: string;
  graph: Record<string, { class_type: string; inputs: Record<string, unknown>; [key: string]: unknown }>;
  inputs: Record<string, WorkflowInputBinding>;
};

type StoredWorkflow = {
  id: string;
  name: string;
  sha256: string;
  source_json: string;
};

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateValue(name: string, binding: WorkflowInputBinding, value: unknown): void {
  const valid = binding.type === 'string' ? typeof value === 'string' && value.length <= 8192
    : binding.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : binding.type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value)
    : binding.type === 'boolean' ? typeof value === 'boolean'
    : typeof value === 'string' && Boolean(binding.options?.includes(value));
  if (!valid) throw Error(`Invalid value for workflow input: ${name}`);
  if (typeof value === 'number' && ((binding.min !== undefined && value < binding.min) || (binding.max !== undefined && value > binding.max))) {
    throw Error(`Workflow input is outside its configured range: ${name}`);
  }
}

function parseBundle(value: unknown): WorkflowBundle {
  if (!object(value)) throw Error('Workflow definition must be a JSON object');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || /[\u0000-\u001f\u007f]/.test(value.name)) {
    throw Error('Workflow name must contain 1 to 100 printable characters');
  }
  if (!object(value.graph) || Object.keys(value.graph).length < 1 || Object.keys(value.graph).length > 2000) {
    throw Error('Workflow graph must contain between 1 and 2000 nodes');
  }
  for (const [nodeId, node] of Object.entries(value.graph)) {
    if (!/^\d+$/.test(nodeId) || !object(node) || typeof node.class_type !== 'string' || !node.class_type.trim() || !object(node.inputs)) {
      throw Error('Workflow graph contains an invalid API node');
    }
  }
  if (value.inputs === undefined) value.inputs = {};
  if (!object(value.inputs) || Object.keys(value.inputs).length > 64) throw Error('Workflow inputs must be an object with at most 64 entries');

  const inputs: Record<string, WorkflowInputBinding> = {};
  for (const [name, raw] of Object.entries(value.inputs)) {
    if (!INPUT_NAME.test(name) || !object(raw)) throw Error('Workflow contains an invalid input declaration');
    if (typeof raw.node_id !== 'string' || !object(value.graph[raw.node_id])) throw Error(`Workflow input node does not exist: ${String(raw.node_id)}`);
    if (typeof raw.field !== 'string' || !raw.field.trim() || !Object.hasOwn(value.graph[raw.node_id].inputs, raw.field)) {
      throw Error(`Workflow input field does not exist: ${name}`);
    }
    if (typeof raw.type !== 'string' || !INPUT_TYPES.has(raw.type)) throw Error(`Workflow input type is not supported: ${name}`);
    const binding = {
      node_id: raw.node_id,
      field: raw.field,
      type: raw.type as WorkflowInputBinding['type'],
      ...(raw.required === undefined ? {} : { required: raw.required }),
      ...(raw.default === undefined ? {} : { default: raw.default }),
      ...(raw.min === undefined ? {} : { min: raw.min }),
      ...(raw.max === undefined ? {} : { max: raw.max }),
      ...(raw.options === undefined ? {} : { options: raw.options }),
    };
    if (binding.required !== undefined && typeof binding.required !== 'boolean') throw Error(`Workflow required flag must be boolean: ${name}`);
    for (const bound of [binding.min, binding.max]) if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) throw Error(
      `Workflow input range must be finite: ${name}`);
    if (binding.min !== undefined && binding.max !== undefined && binding.min > binding.max) throw Error(`Workflow input range is inverted: ${name}`);
    if (binding.type === 'enum' && (!Array.isArray(binding.options) || binding.options.length < 1 || binding.options.length > 100 ||
      binding.options.some((item) => typeof item !== 'string'))) {
      throw Error(`Workflow enum requires 1 to 100 string options: ${name}`);
    }
    if (binding.type !== 'enum' && binding.options !== undefined) throw Error(`Workflow options are only valid for enum inputs: ${name}`);
    if (binding.default !== undefined) validateValue(name, binding, binding.default);
    inputs[name] = binding;
  }

  return { name: value.name.trim(), graph: value.graph, inputs };
}

export class ComfyWorkflowCatalog {
  readonly home: string;
  private readonly workflowsHome: string;

  constructor(home = process.env.ISYMCP_COMFYUI_HOME?.trim() || join(homedir(), '.local', 'state', 'isymcp', 'comfyui')) {
    this.home = home;
    this.workflowsHome = join(home, 'workflows');
    mkdirSync(this.workflowsHome, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'jobs'), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'assets'), { recursive: true, mode: 0o700 });
  }

  private file(id: string): string {
    if (!WORKFLOW_ID.test(id)) throw Error('Invalid workflow ID');
    return join(this.workflowsHome, `${id}.json`);
  }

  add(sourcePath: string): { id: string; name: string; sha256: string } {
    if (extname(sourcePath).toLowerCase() !== '.json') throw Error('Workflow definition must be a .json file');
    const realPath = realpathSync(sourcePath);
    const size = statSync(realPath).size;
    if (!Number.isSafeInteger(size) || size < 2 || size > MAX_WORKFLOW_BYTES) throw Error('Workflow definition must be at most 10 MiB');
    const bytes = readFileSync(realPath);
    let bundle: WorkflowBundle;
    try { bundle = parseBundle(JSON.parse(bytes.toString('utf8'))); }
    catch (error) { throw Error(error instanceof Error ? error.message : 'Invalid workflow JSON'); }
    const record: StoredWorkflow = {
      id: `workflow_${randomUUID()}`,
      name: bundle.name,
      sha256: digest(bytes),
      source_json: bytes.toString('utf8'),
    };
    const target = this.file(record.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
    return { id: record.id, name: record.name, sha256: record.sha256 };
  }

  get(id: string): { id: string; name: string; sha256: string; bundle: WorkflowBundle } {
    const record = JSON.parse(readFileSync(this.file(id), 'utf8')) as StoredWorkflow;
    if (record.id !== id || digest(Buffer.from(record.source_json, 'utf8')) !== record.sha256) throw Error('Workflow integrity check failed');
    return { id, name: record.name, sha256: record.sha256, bundle: parseBundle(JSON.parse(record.source_json)) };
  }

  buildPrompt(id: string, supplied: unknown): WorkflowBundle['graph'] {
    if (!object(supplied)) throw Error('Workflow inputs must be an object');
    const bundle = this.get(id).bundle;
    for (const name of Object.keys(supplied)) if (!Object.hasOwn(bundle.inputs, name)) throw Error(`Unknown workflow input: ${name}`);
    const graph = structuredClone(bundle.graph);
    for (const [name, binding] of Object.entries(bundle.inputs)) {
      const value = Object.hasOwn(supplied, name) ? supplied[name] : binding.default;
      if (value === undefined) {
        if (binding.required) throw Error(`Required workflow input is missing: ${name}`);
        continue;
      }
      validateValue(name, binding, value);
      graph[binding.node_id].inputs[binding.field] = value;
    }
    return graph;
  }

  list(): Array<{ id: string; name: string; sha256: string; inputs: string[] }> {
    return readFileSyncList(this.workflowsHome).map((record) => ({ id: record.id, name: record.name, sha256: record.sha256,
      inputs: Object.keys(record.bundle.inputs) }));
  }
}

function readFileSyncList(directory: string): Array<{ id: string; name: string; sha256: string; bundle: WorkflowBundle }> {
  return readdirSync(directory).filter((name) => /^workflow_[a-f0-9-]{36}\.json$/.test(name)).map((name) => {
    const file = join(directory, name);
    const record = JSON.parse(readFileSync(file, 'utf8')) as StoredWorkflow;
    if (record.id !== name.slice(0, -5) || digest(Buffer.from(record.source_json, 'utf8')) !== record.sha256) throw Error('Workflow integrity check failed');
    return { id: record.id, name: record.name, sha256: record.sha256, bundle: parseBundle(JSON.parse(record.source_json)) };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
