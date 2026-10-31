// M3: isymcp doctor determinista.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDoctor, latestFailedImport, runDoctor } from '../src/doctor';

const home = () => mkdtempSync(join(tmpdir(), 'isymcp-doctor-'));

describe('M3: runDoctor', () => {
  test('con herramientas presentes el reporte es ok', () => {
    const probe = (_cmd: string, args: string[]) => (args[0] === '--version' ? '2026.08.19' : 'ffmpeg version 6.1.1');
    const report = runDoctor({ probe, exists: () => true, mediaHome: home(), home: home() });
    expect(report.version).toBe('isymcp-doctor/1');
    for (const id of ['node', 'platform', 'yt-dlp', 'ffmpeg', 'ffprobe', 'browser', 'catalog', 'disk']) {
      const check = report.checks.find((c) => c.id === id);
      expect(check).toBeDefined();
      expect(check!.status).not.toBe('fail');
    }
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('sin ffmpeg el reporte falla y lo lista en errors', () => {
    const probe = (_cmd: string, args: string[]) => (args[0] === '--version' ? '2026.08.19' : _cmd === 'ffprobe' ? 'ffprobe version 6.1.1' : undefined);
    const report = runDoctor({ probe, exists: () => true, mediaHome: home(), home: home() });
    expect(report.ok).toBe(false);
    expect(report.errors.map((c) => c.id)).toEqual(['ffmpeg']);
  });

  test('el ultimo fallo de media se lee del catalogo local', () => {
    const mediaHome = home();
    const dir = join(mediaHome, 'downloads', 'import-abc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ state: 'failed', error_code: 'media_youtube_bot_wall', error: 'not a bot' }));
    expect(latestFailedImport(mediaHome)).toMatchObject({ error_code: 'media_youtube_bot_wall', error: 'not a bot' });
    const report = runDoctor({ probe: () => 'x', exists: () => true, mediaHome, home: home() });
    expect(report.checks.find((c) => c.id === 'media-error')!.detail).toContain('media_youtube_bot_wall');
  });

  test('un fallo anterior a un import completado deja de reportarse (catalogo recuperado)', () => {
    const mediaHome = home();
    const failed = join(mediaHome, 'downloads', 'import-old');
    const done = join(mediaHome, 'downloads', 'import-new');
    mkdirSync(failed, { recursive: true });
    mkdirSync(done, { recursive: true });
    writeFileSync(join(failed, 'job.json'), JSON.stringify({ state: 'failed', error: 'fallo historico' }));
    writeFileSync(join(done, 'job.json'), JSON.stringify({ state: 'complete', phase: 'ready' }));
    // El completado es mas reciente: el fallo viejo ya no es actividad vigente.
    const touch = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));
    touch(join(failed, 'job.json'), Date.now() - 86_400_000);
    touch(join(done, 'job.json'), Date.now());
    expect(latestFailedImport(mediaHome)).toBeUndefined();
    const report = runDoctor({ probe: () => 'x', exists: () => true, mediaHome, home: home() });
    const check = report.checks.find((c) => c.id === 'media-error')!;
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('sin fallos registrados');

    // Si el fallo pasa a ser lo mas reciente, vuelve a reportarse.
    touch(join(failed, 'job.json'), Date.now());
    touch(join(done, 'job.json'), Date.now() - 86_400_000);
    expect(latestFailedImport(mediaHome)).toMatchObject({ error: 'fallo historico' });
  });

  test('formatDoctor es legible y reporta el resumen', () => {
    const report = runDoctor({ probe: () => undefined, exists: () => false, mediaHome: home(), home: home() });
    const text = formatDoctor(report);
    expect(text).toContain('isymcp doctor');
    expect(text).toMatch(/\d+ ok, \d+ aviso, \d+ falla/);
  });

  test('runDoctor real no lanza y siempre reporta node', () => {
    const report = runDoctor();
    expect(report.checks.find((c) => c.id === 'node')!.status).toBe('ok');
  }, 30_000);
});
