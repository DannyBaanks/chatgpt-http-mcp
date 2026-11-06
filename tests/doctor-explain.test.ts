// M6: explicacion opt-in: prompt saneado, degradacion silenciosa y cero ejecucion.
import { describe, expect, test } from 'bun:test';
import { EXPLAIN_ENV, buildExplainPrompt, defaultExplainRunner, explainReport } from '../src/doctor-explain';
import type { DoctorReport } from '../src/doctor';

const fail = {
  id: 'yt-dlp',
  label: 'yt-dlp',
  status: 'fail' as const,
  detail: 'no encontrado en /home/danny/secreto/bin?token=abc https://example.com/x?sig=deadbeef',
};

const report: DoctorReport = {
  version: 'isymcp-doctor/1',
  ok: false,
  checks: [fail, { id: 'disk', label: 'disco', status: 'ok', detail: '10 GB libres' }],
  errors: [fail],
  remedy: { code: 'media_tool_missing', cause: 'Falta yt-dlp', remedy: 'Instala la herramienta', command_hint: 'isymcp doctor' },
};

describe('M6: doctor --explain', () => {
  test('el prompt lleva el codigo y el remedio', () => {
    const prompt = buildExplainPrompt(report);
    expect(prompt).toContain('media_tool_missing');
    expect(prompt).toContain('Instala la herramienta');
    expect(prompt).toContain('fallas: yt-dlp');
  });

  test('el prompt sanea rutas, URLs y tokens antes de salir del proceso', () => {
    const prompt = buildExplainPrompt(report);
    expect(prompt).not.toContain('/home/danny');
    expect(prompt).not.toContain('example.com');
    expect(prompt).not.toContain('deadbeef');
    expect(prompt).toContain('[path]');
  });

  test('el prompt queda acotado', () => {
    expect(buildExplainPrompt(report).length).toBeLessThanOrEqual(1200);
  });

  test('explainReport pasa el prompt al motor y recorta la respuesta', async () => {
    let seen = '';
    const text = await explainReport(report, async (prompt) => {
      seen = prompt;
      return '  Causa probable: falta yt-dlp.  ';
    });
    expect(text).toBe('Causa probable: falta yt-dlp.');
    expect(seen).toContain('media_tool_missing');
  });

  test('un motor que falla o responde vacio degrada sin lanzar', async () => {
    expect(await explainReport(report, async () => { throw new Error('boom'); })).toBeUndefined();
    expect(await explainReport(report, async () => '   ')).toBeUndefined();
  });

  test('sin ISYMCP_EXPLAIN_CMD no hay motor por defecto', () => {
    expect(defaultExplainRunner({})).toBeUndefined();
    expect(defaultExplainRunner({ [EXPLAIN_ENV]: '   ' })).toBeUndefined();
    expect(typeof defaultExplainRunner({ [EXPLAIN_ENV]: 'cat' })).toBe('function');
  });

  test('el motor por defecto solo alimenta stdin: no ejecuta lo que el modelo proponga', async () => {
    // `cat` devuelve el prompt; aunque el texto contuviera un comando, no se ejecuta.
    const runner = defaultExplainRunner({ [EXPLAIN_ENV]: 'cat' })!;
    const out = await runner('rm -rf /tmp/no-debe-ejecutarse');
    expect(out.trim()).toBe('rm -rf /tmp/no-debe-ejecutarse');
    expect(typeof out).toBe('string');
  });
});
