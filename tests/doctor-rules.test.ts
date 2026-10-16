// M4: cobertura 1:1 del catalogo de codigos y reglas de remedio.
import { describe, expect, test } from 'bun:test';
import { MEDIA_ERROR_CODES } from '../src/media/error-codes';
import { DOCTOR_RULES, ruleFor } from '../src/doctor-rules';

describe('M4: reglas de remedio', () => {
  test('cada codigo del catalogo tiene exactamente una regla', () => {
    const codes = Object.keys(MEDIA_ERROR_CODES).sort();
    const rules = Object.keys(DOCTOR_RULES).sort();
    expect(rules).toEqual(codes);
  });

  test('toda regla tiene causa y remedio no vacios', () => {
    for (const [code, rule] of Object.entries(DOCTOR_RULES)) {
      expect(code.startsWith('media_')).toBe(true);
      expect(rule.cause.length).toBeGreaterThan(0);
      expect(rule.remedy.length).toBeGreaterThan(0);
    }
  });

  test('el muro anti-bot explica la politica sin cookies y referencia la guia', () => {
    const rule = ruleFor('media_youtube_bot_wall')!;
    expect(rule.remedy.toLowerCase()).toContain('cookies');
    expect(rule.guide_anchor).toContain('GUIA.md');
  });

  test('ruleFor de un codigo desconocido es undefined', () => {
    expect(ruleFor('media_no_existe')).toBeUndefined();
    expect(ruleFor(undefined)).toBeUndefined();
  });
});
