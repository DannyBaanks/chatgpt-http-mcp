import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, existsSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { submitOnce, type BrowserDriverPort, type SubmissionRequest, type SubmissionReceipt } from './browser-driver';
import type { ConversationSnapshot } from './browser-observer';

const MAX_FRAME = 1024 * 1024;
function privatePath(path: string, socket = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) ||
      (socket ? !stat.isSocket() : !stat.isDirectory())) throw Error('visible_worker_path_not_private');
}
function authorized(actual: unknown, expected: string) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Only browser operations cross this private socket. Execution remains owned
// by the native Codex turn; no command, patch or filesystem RPC exists here.
export async function createBrowserWorker(options: {
  directory: string;
  connectorId: string;
  driver: BrowserDriverPort;
  readAnswer(source: { url: string; messageId: string }): Promise<ConversationSnapshot>;
}) {
  if (!isAbsolute(options.directory)) throw Error('visible_worker_path_not_private');
  privatePath(options.directory);
  const socketPath = join(options.directory, 'browser.sock');
  if (existsSync(socketPath)) throw Error('visible_worker_endpoint_exists');
  const token = randomBytes(32).toString('hex');
  const sources = new Map<string, SubmissionReceipt>();
  let queue = Promise.resolve();
  const clients = new Set<ReturnType<typeof createConnection>>();
  async function dispatch(request: any) {
    if (!authorized(request.token, token)) throw Error('visible_worker_unauthorized');
    const operation = request.operation;
    if (operation?.method === 'inspect') return options.driver.inspect();
    if (operation?.method === 'submit') {
      const submission = operation.request as SubmissionRequest;
      if (!submission || submission.connectorId !== options.connectorId) throw Error('visible_connector_identity_mismatch');
      const receipt = await submitOnce(options.directory, options.driver, submission);
      sources.set(receipt.requestId, receipt);
      return receipt;
    }
    if (operation?.method === 'read_bound_answer') {
      const source = sources.get(operation.requestId);
      if (!source) throw Error('visible_worker_source_unbound');
      return options.readAnswer({ url: source.url, messageId: source.userMessageId });
    }
    throw Error('visible_worker_method_unsupported');
  }
  const server = createServer(client => {
    client.setEncoding('utf8');
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    let buffer = '', received = false;
    client.setTimeout(30_000, () => client.destroy());
    client.on('data', chunk => {
      if (received) return;
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_FRAME) { client.destroy(); return; }
      if (!buffer.includes('\n')) return;
      received = true;
      let request: unknown;
      try { request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); }
      catch { client.end(JSON.stringify({ error: 'visible_worker_invalid_frame' }) + '\n'); return; }
      // All UI reads/writes serialize against the same page, including preflight.
      queue = queue.then(async () => {
        try { const result = await dispatch(request); client.end(JSON.stringify({ result }) + '\n'); }
        catch (error) {
          const message = error instanceof Error && /^visible_[a-z_]+$/.test(error.message)
            ? error.message : 'visible_worker_operation_failed';
          client.end(JSON.stringify({ error: message }) + '\n');
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(); });
  });
  return {
    socketPath, token,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export async function browserWorkerRpc(socketPath: string, token: string, operation: unknown): Promise<any> {
  if (!isAbsolute(socketPath)) throw Error('visible_worker_path_not_private');
  privatePath(socketPath, true);
  const frame = JSON.stringify({ token, operation }) + '\n';
  if (Buffer.byteLength(frame) > MAX_FRAME) throw Error('visible_worker_frame_too_large');
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.setTimeout(30_000, () => { socket.destroy(); reject(Error('visible_worker_timeout')); });
    socket.once('error', reject);
    socket.once('connect', () => socket.write(frame));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(); reject(Error('visible_worker_frame_too_large')); return; }
      if (!buffer.includes('\n')) return;
      socket.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        if (response.error) reject(Error(response.error)); else resolve(response.result);
      } catch { reject(Error('visible_worker_invalid_frame')); }
    });
    socket.once('end', () => { if (!buffer.includes('\n')) reject(Error('visible_worker_response_incomplete')); });
  });
}
