// M4: cobertura 1:1 del catalogo de codigos y reglas de remedio.
import { describe, expect, test } from 'bun:test';
import { MEDIA_ERROR_CODES } from '../src/media/error-codes';
import { DOCTOR_RULES, ruleFor } from '../src/doctor-rules';
import { FIX_ACTIONS, applyFix, fixActionFor, listFixActions, planFix } from '../src/doctor-fix';

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

describe('M7: --fix con whitelist', () => {
  test('la whitelist es explicita y pequena', () => {
    expect(listFixActions()).toEqual(['media-home']);
  });

  test('toda accion tiene id coincidente y descripcion no vacia', () => {
    for (const [id, action] of Object.entries(FIX_ACTIONS)) {
      expect(action.id).toBe(id);
      expect(action.describe.length).toBeGreaterThan(0);
    }
  });

  test('una accion fuera de la whitelist se rechaza con error claro', () => {
    expect(fixActionFor('borrar-todo')).toBeUndefined();
    expect(() => planFix('borrar-todo')).toThrow(/accion no permitida/);
    expect(() => applyFix('borrar-todo', { mediaHome: '/tmp/x' })).toThrow(/permitidas: media-home/);
  });

  test('media-home solo crea el directorio y no borra nada', () => {
    const created: string[] = [];
    const result = applyFix('media-home', { mediaHome: '/tmp/isymcp-mediahome', mkdir: (path) => created.push(path) });
    expect(result.ok).toBe(true);
    expect(created).toEqual(['/tmp/isymcp-mediahome']);
    expect(result.detail).toContain('/tmp/isymcp-mediahome');
  });
});
