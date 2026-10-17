// launcher-shortcut.test.ts — reintento del acceso directo de Windows.
// El COM de WScript.Shell puede colgar en un runner frio; createWindowsShortcut
// reintenta con timeout creciente. Se prueba con `true`/`false` (POSIX) en vez
// de PowerShell, asi que el job windows-host no ejecuta este archivo.
import { describe, expect, test } from "bun:test";
import { createWindowsShortcut } from "../src/codex-launcher";

const posixOnly = process.platform === "win32" ? test.skip : test;

describe("createWindowsShortcut (reintento)", () => {
  posixOnly("devuelve sin lanzar cuando el comando sale 0", () => {
    expect(() => createWindowsShortcut("true", "ignored")).not.toThrow();
  });

  posixOnly("reintenta y falla con un error claro cuando el comando siempre sale != 0", () => {
    const started = Date.now();
    expect(() => createWindowsShortcut("false", "ignored")).toThrow(/tras 3 intentos/);
    // dos esperas de 500 ms entre los tres intentos
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  }, 20000);
});
