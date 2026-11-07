// tests/platform-process.test.ts — la sonda de procesos, ahora en una sola enumeracion.
//
// El senuelo lleva un GUID en SU PROPIA linea de comando: la enumeracion tambien ve la
// del proceso de test, asi que un literal fijo como "no-existe" podria coincidir por
// casualidad y el test daria verde sin comprobar nada.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { processMatches, processMatchesTable } from "../src/platform/process";

const alive = randomUUID();
let decoy: ReturnType<typeof Bun.spawn> | undefined;
beforeAll(() => { decoy = Bun.spawn([process.execPath, "-e", "Bun.sleep(30_000)", alive], { stdout: "ignore", stderr: "ignore" }); });
afterAll(() => { decoy?.kill(); });

const win32Test = process.platform === "win32" ? test : test.skip;

test("un GUID en el argv del senuelo es el unico patron que puede coincidir", () => {
  const needles = [alive, "zzz-nada-de-esto-existe-zzz", "", process.execPath];
  const table = processMatchesTable(needles);
  expect(table[0]).toBe(true);
  expect(table[1]).toBe(false);
  // El patron vacio coincidiria con TODO (IndexOf("") es 0): se niega explicitamente.
  expect(table[2]).toBe(false);
  expect(table[3]).toBe(true);
  // La tabla y la llamada individual tienen que decir lo mismo, patron a patron.
  expect(table).toEqual(needles.map(processMatches));
}, 30_000);

test("una lista de 9 patrones se trocea y responde en dos enumeraciones", () => {
  const needles = Array.from({ length: 9 }, (_, i) => `isymcp-sonda-${i}-${randomUUID()}`);
  needles[3] = alive;
  needles[8] = process.execPath;
  const found = processMatchesTable(needles);
  expect(found.map((hit, i) => (hit ? i : -1)).filter((i) => i >= 0)).toEqual([3, 8]);
  expect(processMatchesTable([])).toEqual([]);
}, 30_000);

// Criterio del riesgo: PowerShell roto sale con exit 1, que es JUSTO el bit del
// patron 0. Sin el centinela 128 el panel diria "tunnel: ready" con la sonda rota.
win32Test("si PowerShell no arranca, todos los patrones son falsos (fail closed)", () => {
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = `C:\\isymcp-sin-powershell-${randomUUID()}`;
  try {
    expect(processMatchesTable([alive])).toEqual([false]);
    expect(processMatches(alive)).toBe(false);
  } finally {
    process.env.SystemRoot = saved;
  }
}, 30_000);
