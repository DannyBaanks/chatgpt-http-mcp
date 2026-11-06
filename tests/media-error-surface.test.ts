// M2: el codigo estable llega a las superficies MCP y CLI.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaCatalog } from '../src/media/catalog';
import { MediaImporter } from '../src/media/importer';
import { MediaService } from '../src/media/service';
import { mediaCommand } from '../src/media/cli';
import { MediaFailure } from '../src/media/error-codes';

const home = () => mkdtempSync(join(tmpdir(), 'isymcp-surface-'));

describe('M2: superficie MCP', () => {
  test('media_import_status devuelve error_code cuando el job falla', async () => {
    const catalog = new MediaCatalog(join(home(), 'state'));
    const service = new MediaService(catalog);
    (service as unknown as { importer: MediaImporter }).importer = new MediaImporter(catalog, async () => {
      throw Error("ERROR: [youtube] YC5Papilj6E: Sign in to confirm you're not a bot.");
    });
    const started: any = await service.call('media_import', { url: 'https://youtu.be/YC5Papilj6E' });
    const jobId = JSON.parse(started.content[0].text).job_id;
    await new Promise((r) => setTimeout(r, 30));
    const status: any = await service.call('media_import_status', { job_id: jobId });
    const payload = JSON.parse(status.content[0].text);
    expect(status.isError).toBe(true);
    expect(payload.error_code).toBe('media_youtube_bot_wall');
    expect(payload.error).toContain('not a bot');
  });

  test('media_lookup invalida devuelve error_code media_invalid_url', async () => {
    const catalog = new MediaCatalog(join(home(), 'state'));
    const service = new MediaService(catalog);
    const invalid: any = await service.call('media_lookup', { url: 'http://127.0.0.1/private' });
    expect(invalid.isError).toBe(true);
    expect(JSON.parse(invalid.content[0].text).error_code).toBe('media_invalid_url');
  });

  test('media_lookup de una URL valida no registrada no es error', async () => {
    const catalog = new MediaCatalog(join(home(), 'state'));
    const service = new MediaService(catalog);
    const out: any = await service.call('media_lookup', { url: 'https://www.youtube.com/watch?v=abcdefghijk' });
    expect(out.isError).not.toBe(true);
    expect(JSON.parse(out.content[0].text)).toMatchObject({ found: false, status: 'not_found' });
  });

  test('media_busy lleva error_code', async () => {
    const catalog = new MediaCatalog(join(home(), 'state'));
    const file = join(home(), 'c.wav');
    writeFileSync(file, 'audio bytes');
    const a = await catalog.add(file);
    const service = new MediaService(catalog);
    const first = service.call('media_info', { asset_id: a.id });
    const second: any = await service.call('media_info', { asset_id: a.id });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain('busy');
    expect(JSON.parse(second.content[0].text).error_code).toBe('media_busy');
    await first;
  });
});

describe('M2: superficie CLI', () => {
  test('un import con bot-wall lanza MediaFailure con codigo', async () => {
    const catalog = new MediaCatalog(join(home(), 'catalog'));
    const importer = new MediaImporter(catalog, async () => {
      throw Error("ERROR: [youtube] YC5Papilj6E: Sign in to confirm you're not a bot.");
    });
    const error = await mediaCommand('prepare', ['https://youtu.be/YC5Papilj6E'], { catalog, importer }).catch((e) => e);
    expect(error).toBeInstanceOf(MediaFailure);
    expect((error as MediaFailure).code).toBe('media_youtube_bot_wall');
    expect((error as MediaFailure).message).toContain('not a bot');
  });

  test('una URL invalida lanza MediaFailure media_invalid_url', async () => {
    const catalog = new MediaCatalog(join(home(), 'catalog'));
    const error = await mediaCommand('prepare', ['http://127.0.0.1/private'], { catalog }).catch((e) => e);
    expect(error).toBeInstanceOf(MediaFailure);
    expect((error as MediaFailure).code).toBe('media_invalid_url');
  });

  test('un fallo sin firma conserva el mensaje historico y codigo download_unknown', async () => {
    const catalog = new MediaCatalog(join(home(), 'catalog'));
    const importer = new MediaImporter(catalog, async () => { throw Error('HTTP 403'); });
    const error = await mediaCommand('prepare', ['https://youtu.be/lHkDE3BahB0'], { catalog, importer }).catch((e) => e);
    expect((error as MediaFailure).code).toBe('media_download_unknown');
    expect((error as MediaFailure).message).toContain('Download or media validation failed');
  });
});
