// settings.test.ts — "Sincronizar ajustes": guardado seguro del storage-state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLoggedIn, openSettingsWindow, replaceStorageState, settingsStatus } from "../src/chatgpt-settings";
import { loadConfig } from "../src/config";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "isymcp-settings-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const session = (value = "x") => ({ cookies: [{ name: "__Secure-next-auth.session-token", domain: ".chatgpt.com", value }], origins: [] });

describe("storage-state", () => {
  test("looksLoggedIn exige cookie de sesion de chatgpt.com con valor", () => {
    expect(looksLoggedIn(session())).toBe(true);
    expect(looksLoggedIn({ cookies: [{ name: "__Secure-next-auth.session-token.0", domain: "chatgpt.com", value: "a" }] })).toBe(true);
    expect(looksLoggedIn(session(""))).toBe(false);
    expect(looksLoggedIn({ cookies: [{ name: "__Secure-next-auth.session-token", domain: ".evil.com", value: "a" }] })).toBe(false);
    expect(looksLoggedIn({ cookies: [] })).toBe(false);
  });

  test("replaceStorageState respalda el anterior (0600) y conserva solo 5 backups propios", () => {
    const state = join(dir, "storage-state.json");
    writeFileSync(state, JSON.stringify(session("v0")), { mode: 0o600 });
    writeFileSync(join(dir, "otra-cosa.bak-2020"), "no es nuestro");
    for (let i = 1; i <= 7; i++) {
      const backup = replaceStorageState(state, session(`v${i}`), Date.UTC(2026, 9, 7, 0, 0, i));
      expect(backup && statSync(backup).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(state, "utf8")).cookies[0].value).toBe("v7");
    expect(statSync(state).mode & 0o777).toBe(0o600);
    const backups = readdirSync(dir).filter((n) => n.startsWith("storage-state.json.bak-")).sort();
    expect(backups).toHaveLength(5);
    // El mas reciente respaldo contiene v6 (el estado previo al ultimo guardado).
    expect(JSON.parse(readFileSync(join(dir, backups[4]!), "utf8")).cookies[0].value).toBe("v6");
    // Archivos ajenos no se tocan.
    expect(readdirSync(dir)).toContain("otra-cosa.bak-2020");
  });
});

describe("ventana de ajustes", () => {
  test("sin pantalla se niega (no lanza Chrome a ciegas)", () => {
    const saved = { d: process.env.DISPLAY, w: process.env.WAYLAND_DISPLAY };
    delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
    try {
      const r = openSettingsWindow(loadConfig({ CODEX_WEB_HTTP_STATE_PATH: join(dir, "nope.json") }));
      expect(r.started).toBe(false);
      expect(r.reason).toContain("pantalla");
      expect(settingsStatus().state).toBe("idle");
    } finally {
      if (saved.d !== undefined) process.env.DISPLAY = saved.d;
      if (saved.w !== undefined) process.env.WAYLAND_DISPLAY = saved.w;
    }
  });
});
