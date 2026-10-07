// chatgpt-settings.ts — "Sincronizar ajustes": el usuario configura ChatGPT a
// mano (modelo, reasoning/potencia...) en un Chrome VISIBLE con su misma
// sesion, y al cerrarlo ISyMCP guarda el estado para que el headless arranque
// con esos defaults. "Verificar" lee (solo lectura) lo que ve el headless.
//
// Hallazgo que motivo esto (2026-10-07): el headless del bridge mostraba
// "GPT-5.6 Sol · Instant (1 de 3)" mientras el uso real es Sol en "high". La
// eleccion no vive en localStorage ni en cookies visibles: o es del servidor
// (cuenta) o de IndexedDB, por eso el estado se guarda CON IndexedDB y la
// verificacion posterior dice si quedo.
//
// Reglas:
//   - Todo corre dentro de withWebLock: mientras la ventana esta abierta, los
//     turnos de chat esperan en cola (no hay dos Chrome con la misma sesion).
//   - El storage-state solo se reemplaza si el snapshot sigue logueado; antes
//     se respalda el anterior (<state>.bak-<ts>, 0600; se conservan 5).
//   - El headless se relanza solo en el siguiente turno con el estado nuevo.
import { chmodSync, existsSync, readdirSync, renameSync, unlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Page } from "playwright-core";
import type { AppConfig } from "./config";
import {
  CHATGPT_HOME, chromeExecutable, closeWebSession, launchChatGPTBrowser, withSessionPage, withWebLock,
} from "./web-turn";

export interface ComposerSettings {
  /** Texto del boton del selector (p. ej. "Instant"). */
  pill: string | null;
  /** Modelo marcado en el menu (p. ej. "GPT-5.6 Sol"). */
  model: string | null;
  /** Nivel de potencia/reasoning (p. ej. "Instant") y su posicion. */
  effort: string | null;
  effortPosition: number | null;
  effortSteps: number | null;
}

export interface SyncResult {
  saved: boolean;
  reason: string;
  at: string;
  backup?: string | null;
  cookies?: number;
  indexedDB?: boolean;
}

type SettingsState = "idle" | "open" | "saving";
let state: SettingsState = "idle";
let lastResult: SyncResult | null = null;
let lastSeen: (ComposerSettings & { at: string }) | null = null;
let finishSignal: (() => void) | null = null;

export function settingsStatus() {
  return { state, last: lastResult, seen: lastSeen };
}

const MODEL_BUTTON = 'button[aria-label="Seleccionar modelo de ChatGPT"], button[data-testid="model-switcher-dropdown-button"]';

/** Lee el selector de modelo sin cambiar nada (abre el menu y lo cierra con Escape). */
export async function readComposerSettings(page: Page): Promise<ComposerSettings> {
  const empty: ComposerSettings = { pill: null, model: null, effort: null, effortPosition: null, effortSteps: null };
  try {
    const button = page.locator(MODEL_BUTTON).first();
    await button.waitFor({ state: "visible", timeout: 15_000 });
    const pill = ((await button.innerText()) || "").trim().replace(/\s+/g, " ") || null;
    await button.click();
    // Esperar a que el menu termine de montarse (el deslizante de potencia
    // llega despues que los items): con una espera fija de 900 ms, justo tras
    // navegar a un chat nuevo, se leia "High (?/?)" (visto 2026-10-07, M8).
    const readMenu = () => page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]')) as HTMLElement[];
      const checked = radios.find((r) => r.getAttribute("aria-checked") === "true");
      const texts = radios.map((r) => (r.innerText || "").trim().replace(/\s+/g, " "));
      // Solo dentro del menu abierto: otras barras de la pagina (p. ej. la
      // alerta de uso) tambien llevan aria-valuenow.
      const scope = document.querySelector('[data-radix-popper-content-wrapper], [role="menu"]');
      const slider = (scope?.querySelector('[role="slider"], [aria-valuenow]') ?? null) as HTMLElement | null;
      return {
        model: checked ? (checked.innerText || "").trim().split("\n")[0] : null,
        texts,
        slider: slider ? { now: slider.getAttribute("aria-valuenow"), max: slider.getAttribute("aria-valuemax"), min: slider.getAttribute("aria-valuemin"), text: slider.getAttribute("aria-valuetext") } : null,
      };
    });
    let menu = await readMenu();
    for (let i = 0; i < 10 && !(menu.slider?.now || menu.texts.some((t) => /\d+\s+(?:de|of)\s+\d+/.test(t))); i++) {
      await page.waitForTimeout(400);
      menu = await readMenu();
    }
    await page.keyboard.press("Escape").catch(() => {});
    // "Instant, 1 de 3" (o en ingles "Instant, 1 of 3") en algun item del menu.
    const effortText = menu.texts.map((t) => /([\p{L}][\p{L} ]*?),\s*(\d+)\s+(?:de|of)\s+(\d+)/u.exec(t)).find(Boolean);
    let effort = effortText ? effortText[1]!.trim() : (menu.slider?.text ?? null);
    let effortPosition = effortText ? Number(effortText[2]) : null;
    let effortSteps = effortText ? Number(effortText[3]) : null;
    if (effortPosition === null && menu.slider?.now) {
      const min = Number(menu.slider.min ?? 0);
      effortPosition = Number(menu.slider.now) - min + 1;
      effortSteps = menu.slider.max ? Number(menu.slider.max) - min + 1 : null;
    }
    if (!effort && pill) effort = pill;
    return { pill, model: menu.model, effort, effortPosition, effortSteps };
  } catch {
    return empty;
  }
}

/** "Verificar": que ve el headless ahora mismo. Toma el candado. */
export async function verifySettings(config: AppConfig): Promise<ComposerSettings & { at: string }> {
  return withWebLock(async () => {
    const seen = await withSessionPage({ statePath: config.browserStatePath, browser: config.browser, headed: config.browserHeaded }, readComposerSettings);
    lastSeen = { ...seen, at: new Date().toISOString() };
    return lastSeen;
  });
}

/** La sesion sigue logueada si hay cookie de sesion de next-auth de chatgpt.com. */
export function looksLoggedIn(storage: { cookies?: Array<{ name: string; domain?: string; value?: string }> }): boolean {
  return (storage.cookies ?? []).some((c) =>
    c.name.startsWith("__Secure-next-auth.session-token") && /chatgpt\.com$/.test((c.domain ?? "").replace(/^\./, "")) && Boolean(c.value));
}

/** Escribe el estado nuevo con backup del anterior (0600, se guardan 5). */
export function replaceStorageState(statePath: string, storage: unknown, now = Date.now()): string | null {
  let backup: string | null = null;
  if (existsSync(statePath)) {
    backup = `${statePath}.bak-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(statePath, backup);
    chmodSync(backup, 0o600);
  }
  const tmp = `${statePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(storage), { mode: 0o600 });
  renameSync(tmp, statePath);
  chmodSync(statePath, 0o600);
  // Solo NUESTROS backups (mismo prefijo exacto), los mas viejos primero.
  const prefix = `${basename(statePath)}.bak-`;
  const backups = readdirSync(dirname(statePath)).filter((n) => n.startsWith(prefix)).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - 5))) {
    try { unlinkSync(join(dirname(statePath), old)); } catch { /* best-effort */ }
  }
  return backup;
}

/** Termina la ventana de ajustes (boton "Listo" del panel). */
export function finishSettingsWindow(): boolean {
  if (!finishSignal) return false;
  finishSignal();
  return true;
}

/**
 * Abre la ventana visible en segundo plano y devuelve enseguida. El resultado
 * queda en settingsStatus().last. maxMs: cierre forzado (se guarda igual).
 */
export function openSettingsWindow(config: AppConfig, maxMs = 20 * 60_000): { started: boolean; reason?: string } {
  if (state !== "idle") return { started: false, reason: `ya hay una ventana de ajustes (${state})` };
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { started: false, reason: "no hay pantalla (DISPLAY) para abrir un Chrome visible" };
  }
  state = "open";
  void withWebLock(async () => {
    const statePath = config.browserStatePath;
    let snapshot: { cookies?: Array<{ name: string; domain?: string; value?: string }> } | null = null;
    let usedIndexedDB = false;
    let browserHandle: Awaited<ReturnType<typeof launchChatGPTBrowser>> | null = null;
    try {
      // La sesion headless se cierra: no hay dos Chrome con la misma sesion.
      await closeWebSession();
      browserHandle = await launchChatGPTBrowser(chromeExecutable("chrome"), statePath, { headless: false, sandbox: true, viewport: null });
      const { browser, context, page } = browserHandle;
      await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      const take = async () => {
        try {
          snapshot = await context.storageState({ indexedDB: true }) as typeof snapshot;
          usedIndexedDB = true;
        } catch {
          try { snapshot = await context.storageState() as typeof snapshot; } catch { /* ventana cerrandose */ }
        }
      };
      // Snapshots periodicos: si el usuario cierra la ventana y Chrome se va,
      // se usa el ultimo bueno.
      const timer = setInterval(() => { void take(); }, 3_000);
      await new Promise<void>((resolve) => {
        finishSignal = resolve;
        page.on("close", () => resolve());
        browser.on("disconnected", () => resolve());
        setTimeout(resolve, maxMs);
      });
      clearInterval(timer);
      state = "saving";
      if (browser.isConnected()) await take();
      if (!snapshot) {
        lastResult = { saved: false, reason: "no se pudo leer el estado de la ventana", at: new Date().toISOString() };
      } else if (!looksLoggedIn(snapshot)) {
        lastResult = { saved: false, reason: "la ventana ya no estaba logueada en ChatGPT; no se toco el estado guardado", at: new Date().toISOString() };
      } else {
        const backup = replaceStorageState(statePath, snapshot);
        lastResult = { saved: true, reason: "estado guardado; el headless lo usa desde el siguiente turno", at: new Date().toISOString(), backup, cookies: snapshot.cookies?.length ?? 0, indexedDB: usedIndexedDB };
      }
    } catch (error) {
      lastResult = { saved: false, reason: `fallo la ventana de ajustes: ${error instanceof Error ? error.message : String(error)}`, at: new Date().toISOString() };
    } finally {
      finishSignal = null;
      await browserHandle?.browser.close().catch(() => {});
      state = "idle";
    }
  });
  return { started: true };
}
