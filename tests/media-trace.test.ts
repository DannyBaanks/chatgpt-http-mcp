// Pendiente ISyMCP: el server MCP de medios (src/mcp/media.ts) no dejaba
// evidencia en mcp-trace.log. Ahora registerMediaTools emite call + tool.result.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaCatalog } from '../src/media/catalog';
import { MediaService } from '../src/media/service';
import { registerMediaTools } from '../src/media/register';

function fakeServer() {
  const handlers = new Map<string, (input: any) => Promise<any>>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: (input: any) => Promise<any>) => {
      handlers.set(name, handler);
      return {};
    },
  };
  return { server: server as never, handlers };
}

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env.CODEX_WEB_HTTP_HOME;
  const home = mkdtempSync(join(tmpdir(), 'isymcp-trace-'));
  process.env.CODEX_WEB_HTTP_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
    else process.env.CODEX_WEB_HTTP_HOME = previous;
  }
}

const lines = (home: string) => readFileSync(join(home, 'mcp-trace.log'), 'utf8').trim().split('\n');
const dataOf = (line: string) => JSON.parse(line.slice(line.indexOf('{')));

describe('traza de las tools de medios', () => {
  test('un fallo deja call + tool.result con error_code', async () => {
    await withHome(async (home) => {
      const service = new MediaService(new MediaCatalog(join(home, 'state')));
      const { server, handlers } = fakeServer();
      registerMediaTools(server, service);

      const out = await handlers.get('media_lookup')!({ url: 'http://127.0.0.1/private' });
      expect(out.isError).toBe(true);

      const log = lines(home);
      expect(log.some((l) => l.includes(' call ') && l.includes('media_lookup'))).toBe(true);
      const result = log.find((l) => l.includes(' tool.result ') && l.includes('media_lookup'))!;
      const data = dataOf(result);
      expect(data.ok).toBe(false);
      expect(data.error_code).toBe('media_invalid_url');
      expect(typeof data.call_id).toBe('string');
    });
  });

  test('una llamada correcta deja ok:true y no filtra rutas locales', async () => {
    await withHome(async (home) => {
      const service = new MediaService(new MediaCatalog(join(home, 'state')));
      const { server, handlers } = fakeServer();
      registerMediaTools(server, service);

      const out = await handlers.get('media_list')!({});
      expect(out.isError).toBeFalsy();

      const log = lines(home);
      const result = log.find((l) => l.includes(' tool.result ') && l.includes('media_list'))!;
      expect(dataOf(result).ok).toBe(true);
      expect(log.join('\n')).not.toContain(home);
    });
  });
});
