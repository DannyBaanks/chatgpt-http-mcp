// web-turn.ts — M7: transporte Web reutilizable (browser persistente).
//
// Extrae la logica probada en scripts/e2e-web.ts (M4-B) a un modulo con una
// sesion LAZY y reutilizada: se lanza el browser la primera vez y la misma
// pestana atiende todos los turnos siguientes. Eso es lo que hace comparables
// los turnos del e2e con los de un servidor.
//
// Sin sesion/cookies no inventa nada: devuelve error nombrado.
import { AsyncLocalStorage } from "node:async_hooks";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { sanitizeEvidenceText } from "./sanitize";
import { domToMarkdown, markdownMatchesText } from "./dom-markdown";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WebTurnResult {
  text: string;
  ms: number;
  submitted: boolean;
  reused: boolean;
  url: string;
  /**
   * Markdown reconstruido del DOM de la respuesta (solo si coincide con
   * `text`). Presentacion para el chat local; `text` no cambia.
   */
  markdown?: string;
}

export interface WebTurnOptions {
  statePath?: string;
  browser?: "chrome" | "shell";
  headed?: boolean;
  settleMs?: number;
  deadlineMs?: number;
  /** Si ya hay un chat /c/, no abre otro. */
  conversationUrl?: string;
  /**
   * Nombre EXACTO del connector a seleccionar en el composer antes de enviar
   * (p. ej. "Codex ISyMCP"). Si no se pasa, cae a CODEX_WEB_HTTP_CONNECTOR.
   */
  connector?: string;
  /**
   * Navegacion explicita ANTES del turno (dentro del candado): "new" abre una
   * conversacion nueva; "conversation" va a un /c/ concreto. Sin esto, el
   * turno usa la pestana tal como este (comportamiento historico).
   */
  navigate?: WebNavigation;
  /** Avisos de fase para la UI local (navegando / pensando). */
  onPhase?: (phase: "navigating" | "thinking") => void;
  /**
   * Texto parcial MIENTRAS ChatGPT escribe (cada ~400 ms, solo si cambio).
   * Cada llamada trae la respuesta completa hasta ese momento (reemplaza, no
   * concatena): no hay fragmentos que duplicar. Solo lo usa el chat local.
   */
  onProgress?: (partial: string) => void;
}

export type WebNavigation = { to: "new" } | { to: "conversation"; url: string };

export const CHATGPT_HOME = "https://chatgpt.com/";

/** URL canonica de una conversacion (https://chatgpt.com/c/<id>) o null. */
export function canonicalConversationUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return null;
    const m = /^\/c\/([0-9a-f][0-9a-f-]{7,})\/?$/i.exec(url.pathname);
    return m ? `https://chatgpt.com/c/${m[1].toLowerCase()}` : null;
  } catch {
    return null;
  }
}

/** A donde hay que ir (o null si la pestana ya esta donde debe). */
export function navigationTarget(currentUrl: string, nav: WebNavigation | undefined): string | null {
  if (!nav) return null;
  if (nav.to === "new") return CHATGPT_HOME;
  const target = canonicalConversationUrl(nav.url);
  if (!target) throw new Error(`web_bad_conversation_url: ${nav.url}`);
  return canonicalConversationUrl(currentUrl) === target ? null : target;
}

const CONNECTOR_MENTION_QUERY = "@codex";
const CONNECTOR_MENU_SELECTOR =
  '.__menu-item[tabindex="0"], [data-mention-list-scroll-area] button[data-list-navigation-item="true"]';

function connectorPill(page: Page, appName: string) {
  const quoted = JSON.stringify(appName);
  return page.locator(
    `[data-id^="plugin:"][data-keyword=${quoted}], `
    + `[app-mention-path^="app://"][app-mention-display-name=${quoted}][contenteditable="false"]`,
  );
}

async function connectorSelected(page: Page, appName: string): Promise<boolean> {
  const pill = connectorPill(page, appName).filter({ visible: true });
  return (await pill.count().catch(() => 0)) >= 1;
}

/**
 * Selecciona el connector en el composer (mecanica portada del launcher
 * codex-chatgpt-web: query @codex -> fila exacta del menu (resaltada por
 * teclado) -> Enter -> pill visible). Limpia el composer antes de escribir la
 * mention. Lanza error nombrado si no puede demostrar la seleccion.
 */
async function selectConnector(page: Page, appName: string): Promise<void> {
  if (await connectorSelected(page, appName)) return;
  const composer = page.locator('#prompt-textarea, div[contenteditable="true"]').first();
  const menuRows = page.locator(CONNECTOR_MENU_SELECTOR);
  const appResult = menuRows.filter({ has: page.getByText(appName, { exact: true }) });
  let lastError = "sin intentos";
  for (let attempt = 1; attempt <= 3; attempt++) {
    await composer.click();
    await page.keyboard.press("Control+a").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.waitForTimeout(150);
    await composer.click();
    await composer.pressSequentially(CONNECTOR_MENTION_QUERY, { delay: 25 });
    try {
      // 8s: cuentas con throttling tardan varios segundos en poblar el menu
      // (medido 2026-10-06: la fila aparecio ~9 s despues de tipear @codex).
      await appResult.waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      lastError = `intento ${attempt}: el menu no mostro "${appName}"`;
      continue;
    }
    const exact = await appResult.count().catch(() => 0);
    if (exact !== 1) {
      lastError = `intento ${attempt}: filas exactas=${exact}`;
      continue;
    }
    const highlighted = async () =>
      (await appResult.getAttribute("data-highlighted").catch(() => null)) !== null
      || (await appResult.getAttribute("aria-current").catch(() => null)) === "true";
    if (!(await highlighted())) {
      const visibleRows = await menuRows.filter({ visible: true }).count().catch(() => 0);
      for (let step = 0; step < visibleRows && !(await highlighted()); step++) {
        await composer.press("ArrowDown").catch(() => {});
      }
    }
    if (!(await highlighted())) {
      lastError = `intento ${attempt}: la fila no se pudo resaltar`;
      continue;
    }
    await composer.press("Enter");
    try {
      await connectorPill(page, appName).first().waitFor({ state: "visible", timeout: 15_000 });
      return;
    } catch {
      lastError = `intento ${attempt}: sin pill tras Enter`;
    }
  }
  throw new Error(`web_connector_unavailable: ${appName} (${lastError})`);
}

function shellBinary(): string {
  const base = join(homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(base)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const bin = join(base, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(bin)) return bin;
  }
  throw new Error("no encontre chrome-headless-shell en ~/.cache/ms-playwright");
}

/**
 * Cloudflare rechaza HeadlessChrome + navigator.webdriver. Este combo pasa:
 * UA del Chrome real (cf_clearance esta atado a ese UA), sin --enable-automation
 * y con la feature AutomationControlled apagada.
 */
function chromeVersion(bin: string): string {
  try {
    const out = Bun.spawnSync([bin, "--version"]).stdout.toString();
    return /(\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1] ?? "153.0.0.0";
  } catch {
    return "153.0.0.0";
  }
}
/** Chrome completo; CODEX_WEB_HTTP_CHROME para rutas fuera de Ubuntu/Debian. */
const CHROME_BINARY = process.env.CODEX_WEB_HTTP_CHROME?.trim() || "/usr/bin/google-chrome";
const normalUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion(CHROME_BINARY)} Safari/537.36`;

/** Extrae la ultima respuesta del asistente a partir de las marcas de la UI. */
export function extractResponse(main: string): string {
  const markers = ["ChatGPT dijo:", "ChatGPT said:"];
  const idx = Math.max(...markers.map((m) => main.lastIndexOf(m)));
  if (idx < 0) return "";
  let rest = main.slice(idx + markers[0].length);
  const cut = rest.search(
    /(ChatGPT puede cometer errores|ChatGPT can make mistakes|Última respuesta|Tú dijiste:|You said:)/i,
  );
  if (cut > 0) rest = rest.slice(0, cut);
  return rest.trim();
}

let session: { browser: Browser; page: Page; key: string } | undefined;

function isCrashError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /Target crashed|Page crashed|Target closed|has been closed|browser has been closed/i.test(m);
}

/** M13c: cierra la sesion rota para que openSession relance el browser. */
async function reviveSession(): Promise<void> {
  if (!session) return;
  const current = session;
  session = undefined;
  await current.browser.close().catch(() => {});
}

/** Lanza Chrome con la sesion de ChatGPT (mismo perfil para headless y visible). */
export async function launchChatGPTBrowser(
  executablePath: string,
  statePath: string,
  opts: { headless: boolean; sandbox: boolean; viewport?: { width: number; height: number } | null },
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    executablePath,
    headless: opts.headless,
    // El headless shell no soporta el sandbox de Chrome; el Chrome completo si.
    chromiumSandbox: opts.sandbox,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    storageState: statePath,
    locale: "es-ES",
    userAgent: normalUA,
    viewport: opts.viewport === undefined ? { width: 1280, height: 800 } : opts.viewport,
  });
  const page = await context.newPage();
  return { browser, context, page };
}

async function openSession(options: WebTurnOptions): Promise<{ browser: Browser; page: Page }> {
  const which = options.browser ?? "chrome";
  const statePath = options.statePath ?? join(homedir(), ".codex-web-http", "storage-state.json");
  if (!existsSync(statePath)) {
    throw new Error(`web_session_missing: no existe ${statePath}; corre scripts/import-cookies.ts`);
  }
  const key = `${which}|${statePath}|${options.headed ? "headed" : "headless"}`;
  if (session && session.key === key) return session;

  const executablePath = which === "shell" ? shellBinary() : CHROME_BINARY;
  if (!existsSync(executablePath)) {
    throw new Error(`web_browser_missing: binario no encontrado: ${executablePath}`);
  }
  if (session) await session.browser.close().catch(() => {});
  const { browser, page } = await launchChatGPTBrowser(executablePath, statePath, {
    headless: !options.headed,
    sandbox: which !== "shell",
  });
  const startUrl = options.conversationUrl?.includes("/c/") ? options.conversationUrl : "https://chatgpt.com/";
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const composer = page.locator('#prompt-textarea, div[contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  const loggedIn = (await page.locator('[data-testid="login-button"], a[href="/auth/login"]').count()) === 0;
  if (!loggedIn) {
    await browser.close().catch(() => {});
    throw new Error("web_session_expired: ChatGPT no aparece logueado (cookies vencidas o bloqueadas)");
  }
  session = { browser, page, key };
  return session;
}

/**
 * Envia UN prompt y espera la respuesta completa del asistente. Reutiliza la
 * pestana existente (no la cierra entre turnos).
 */
const ASSISTANT_PRIMARY_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])',
].join(",");
// Fallback solo si el primario no matchea NADA: en union con el primario puede
// capturar contenedores que incluyen el turno del usuario (visto 2026-10-06:
// la respuesta HTTP devolvio el eco del mensaje del usuario).
const ASSISTANT_FALLBACK_SELECTOR = '[data-message-author-role="assistant"]';

/** Identidad del ultimo turno assistant: robusta a la virtualizacion del DOM
 * (el conteo puede no crecer; la identidad cambia). */
async function lastAssistantIdentity(page: Page): Promise<string> {
  return page
    .evaluate(([primary, fallback]) => {
      const primaryTurns = Array.from(document.querySelectorAll(primary));
      const turns = (primaryTurns.length > 0 ? primaryTurns : Array.from(document.querySelectorAll(fallback))) as HTMLElement[];
      const last = turns[turns.length - 1];
      if (!last) return "";
      return last.getAttribute("data-turn-id")
        ?? last.getAttribute("data-testid")
        ?? last.getAttribute("data-message-id")
        ?? (last.innerText ?? "").slice(0, 80);
    }, [ASSISTANT_PRIMARY_SELECTOR, ASSISTANT_FALLBACK_SELECTOR] as const)
    .catch(() => "");
}

async function readLastAssistant(page: Page): Promise<string> {
  const container = await page.evaluate(([primary, fallback]) => {
    const primaryTurns = Array.from(document.querySelectorAll(primary));
    const turns = (primaryTurns.length > 0 ? primaryTurns : Array.from(document.querySelectorAll(fallback))) as HTMLElement[];
    if (turns.length === 0) return "";
    // Preferir el ULTIMO bloque markdown (respuesta del asistente): evita
    // contenedores que incluyen el turno del usuario (eco visto 2026-10-06).
    for (let i = turns.length - 1; i >= 0; i--) {
      const marks = turns[i].querySelectorAll('.markdown');
      if (marks.length > 0) return ((marks[marks.length - 1] as HTMLElement).innerText ?? "").trim();
    }
    return (turns[turns.length - 1].innerText ?? "").trim();
  }, [ASSISTANT_PRIMARY_SELECTOR, ASSISTANT_FALLBACK_SELECTOR] as const);
  // Variante de DOM sin .markdown (dump capture-fail 2026-10-06): el
  // contenedor trae ambos lados ("Tú dijiste: ... ChatGPT dijo: <respuesta>").
  const extracted = extractResponse(container);
  if (extracted) return extracted;
  if (/^(Tú dijiste|You said):/.test(container)) return "";
  return container;
}

/** Markdown de la ultima respuesta (mismo elemento que readLastAssistant). */
async function readLastAssistantMarkdown(page: Page, text: string): Promise<string | undefined> {
  const script = `(() => {
    const toMd = ${domToMarkdown.toString()};
    const primary = Array.from(document.querySelectorAll(${JSON.stringify(ASSISTANT_PRIMARY_SELECTOR)}));
    const turns = primary.length > 0 ? primary : Array.from(document.querySelectorAll(${JSON.stringify(ASSISTANT_FALLBACK_SELECTOR)}));
    for (let i = turns.length - 1; i >= 0; i--) {
      // UI 2026-10: data-markdown-text-style; UI anterior: .markdown.
      const marks = turns[i].querySelectorAll('[data-markdown-text-style="assistant-message"], .markdown');
      if (marks.length > 0) return toMd(marks[marks.length - 1]);
    }
    return "";
  })()`;
  try {
    const markdown = String(await page.evaluate(script));
    return markdown && markdownMatchesText(markdown, text) ? markdown : undefined;
  } catch {
    return undefined;
  }
}

async function assistantTurnCount(page: Page): Promise<number> {
  return page
    .locator('[data-testid^="conversation-turn-"][data-message-author-role="assistant"], [data-turn-key]:has([data-conversation-role="assistant"])')
    .count()
    .catch(() => 0);
}

/**
 * Espera a que la conversacion deje de renderizar antes de capturar la
 * identidad "antes" del turno: si se captura mientras la pagina carga, la
 * virtualizacion cambia identidades y el bridge confunde el ultimo mensaje
 * viejo con una respuesta nueva (carrera observada en la conversacion
 * persistente, 2026-10-06).
 */
async function waitConversationSettle(page: Page, maxMs = 8_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    // Conteo + identidad del ultimo assistant: en una conversacion recargada la
    // virtualizacion re-keyea turnos y "solo conteo" estabiliza a mitad del
    // render (carrera vista 2026-10-06: se devolvio el turno anterior).
    const signature = `${await assistantTurnCount(page)}|${await lastAssistantIdentity(page)}`;
    stable = signature === last ? stable + 1 : 0;
    if (stable >= 2) return;
    last = signature;
    await page.waitForTimeout(500);
  }
}

/**
 * Envia UN prompt y espera la respuesta completa del asistente. Reutiliza la
 * pestana existente (no la cierra entre turnos).
 *
 * Interaccion con la UI actual (ProseMirror): el draft se siembra con
 * document.execCommand("insertText") — locator.fill() deja el composer vacio —
 * y la respuesta se lee del turno del asistente por DOM, no por el texto
 * localizado "ChatGPT dijo:".
 */
/** Dump decisivo cuando la captura termina vacia (Fase 1 del COMPOSE). */
async function dumpCaptureFailure(page: Page): Promise<void> {
  try {
    const dir = join(homedir(), ".codex-web-http", "run", `capture-fail-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, "page.png"), fullPage: false }).catch(() => {});
    const info = await page.evaluate(() => {
      const sel = (s: string) => {
        try {
          const els = Array.from(document.querySelectorAll(s)) as HTMLElement[];
          return { count: els.length, lastText: els.length ? (els[els.length - 1].innerText ?? "").slice(0, 400) : "" };
        } catch {
          return { count: 0, lastText: "" };
        }
      };
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        selectors: {
          conversationTurn: sel('[data-testid^="conversation-turn-"]'),
          authorRole: sel('[data-message-author-role]'),
          markdown: sel(".markdown"),
          assistantPrimary: sel('[data-testid^="conversation-turn-"][data-message-author-role="assistant"], [data-turn-key]:has([data-conversation-role="assistant"])'),
          stopButton: sel('button[data-testid="stop-button"], button[aria-label*="Detener"], button[aria-label*="Stop"]'),
        },
      };
    });
    const dump = sanitizeEvidenceText(JSON.stringify({ ts: new Date().toISOString(), ...info }, null, 2));
    writeFileSync(join(dir, "dump.json"), dump);
  } catch {
    /* el dump nunca debe romper el turno */
  }
}

// Una sola pagina de ChatGPT para todo el proceso: dos turnos a la vez
// escribirian en el mismo composer (y dos primeros turnos lanzarian dos
// Chrome). Todo pasa por este candado, en orden de llegada. Es reentrante
// para que un flujo de varias rondas (context pull/push) lo tome una vez en
// la request y sus sendWebTurn internos no se bloqueen a si mismos.
const webLockContext = new AsyncLocalStorage<true>();
let webLockTail: Promise<unknown> = Promise.resolve();

export function withWebLock<T>(run: () => Promise<T>): Promise<T> {
  if (webLockContext.getStore()) return run();
  const result = webLockTail.then(() => webLockContext.run(true, run));
  webLockTail = result.catch(() => undefined);
  return result;
}

export function sendWebTurn(prompt: string, options: WebTurnOptions = {}): Promise<WebTurnResult> {
  return withWebLock(() => sendWebTurnUnlocked(prompt, options));
}

async function sendWebTurnUnlocked(prompt: string, options: WebTurnOptions = {}): Promise<WebTurnResult> {
  if (!prompt.trim()) throw new Error("web_empty_prompt: prompt vacio");
  const reused = Boolean(session);
  const { page } = await openSession(options);
  const target = navigationTarget(page.url(), options.navigate);
  if (target) {
    options.onPhase?.("navigating");
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator('#prompt-textarea, div[contenteditable="true"]').first().waitFor({ state: "visible", timeout: 60_000 });
  }
  options.onPhase?.("thinking");
  const settleMs = options.settleMs ?? 1_000;
  const deadlineMs = options.deadlineMs ?? 120_000;
  const composer = page.locator('#prompt-textarea, div[contenteditable="true"]').first();
  const t0 = performance.now();
  const composerText = () => composer.innerText().catch(() => "");
  await waitConversationSettle(page);
  const beforeId = await lastAssistantIdentity(page);
  const beforeText = await readLastAssistant(page);

  const connector = options.connector ?? (process.env.CODEX_WEB_HTTP_CONNECTOR?.trim() || undefined);
  if (connector) {
    // La seleccion deja el pill en el composer; el texto se siembra despues
    // (el caret queda al final, el pill se conserva).
    await selectConnector(page, connector);
  } else {
    await composer.click();
    await page.keyboard.press("Control+a").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.waitForTimeout(150);
  }
  await composer.evaluate((el, text) => {
    const element = el as HTMLElement;
    element.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    document.execCommand("insertText", false, text);
  }, prompt);
  await page.waitForTimeout(400);

  const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
  const probe = normalize(prompt).slice(0, 24);
  const seeded = normalize(await composerText());
  if (!seeded || !seeded.includes(probe)) {
    // Segundo intento: CDP Input.insertText (como un IME real) por si el
    // execCommand no sembro el texto multi-linea en ProseMirror.
    const cdp = await page.context().newCDPSession(page);
    try {
      await composer.click();
      await page.keyboard.press("Control+a").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await cdp.send("Input.insertText", { text: prompt });
    } finally {
      await cdp.detach().catch(() => {});
    }
    await page.waitForTimeout(300);
    const retry = normalize(await composerText());
    if (!retry || !retry.includes(probe)) {
      return { text: "", ms: Math.round(performance.now() - t0), submitted: false, reused, url: page.url() };
    }
  }

  try {
  // Enviar: boton Enviar (ES/EN) o Enter. Se confirma por composer vacio.
  let submitted = false;
  for (let attempt = 1; attempt <= 3 && !submitted; attempt++) {
    const send = page
      .locator('button[data-testid="send-button"], #composer-submit-button, button[aria-label*="Enviar"], button[aria-label*="Send"]')
      .first();
    // ChatGPT deshabilita Enviar mientras genera el turno anterior; esperar
    // (visto 2026-10-06: submitted=false en requests consecutivos rapidos).
    for (let wait = 0; wait < 40; wait++) {
      if ((await send.count()) === 0) break;
      if (await send.isEnabled().catch(() => false)) break;
      await page.waitForTimeout(500);
    }
    if ((await send.count()) > 0 && (await send.isEnabled().catch(() => false))) {
      await send.click().catch(() => {});
    } else {
      await composer.press("Enter").catch(() => {});
    }
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(250);
      if (!(await composerText()).trim()) { submitted = true; break; }
    }
  }
  if (!submitted) {
    return { text: "", ms: Math.round(performance.now() - t0), submitted: false, reused, url: page.url() };
  }

  // Esperar el turno del asistente. Fase 1: fin real de la generacion via el
  // indicador "Detener" (evita cortar durante "Ha pensado durante N s", que
  // deja texto intermedio estable). Fase 2: lectura estable del ultimo markdown.
  const deadline = Date.now() + deadlineMs;
  const stopButton = page
    .locator('button[data-testid="stop-button"], button[aria-label*="Detener"], button[aria-label*="Stop"]')
    .first();
  let sawBusy = false;
  let lastProgress = "";
  const graceUntil = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const busy = (await stopButton.count().catch(() => 0)) > 0;
    if (busy) sawBusy = true;
    if (sawBusy && !busy) break;
    if (!sawBusy && Date.now() > graceUntil) break;
    if (busy && options.onProgress) {
      const current = await readLastAssistant(page).catch(() => "");
      // El turno viejo sigue siendo "el ultimo" hasta que aparece el nuevo.
      if (current && current !== beforeText && current !== lastProgress) {
        lastProgress = current;
        const md = await readLastAssistantMarkdown(page, current);
        try { options.onProgress(md ?? current); } catch { /* la UI nunca rompe el turno */ }
      }
    }
    await page.waitForTimeout(400);
  }
  let text = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    const current = await readLastAssistant(page);
    // Con generacion confirmada, el texto previo no es una respuesta valida.
    const acceptable = Boolean(current) && !(sawBusy && current === beforeText);
    if (acceptable && current === text) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= Math.max(1_500, settleMs)) break;
    } else {
      stableSince = 0;
      text = current;
    }
    await page.waitForTimeout(settleMs);
  }
  if (!text.trim()) await dumpCaptureFailure(page);
  const markdown = text.trim() ? await readLastAssistantMarkdown(page, text) : undefined;
  return {
    text: text.trim(),
    ms: Math.round(performance.now() - t0),
    submitted: true,
    reused,
    url: page.url(),
    ...(markdown ? { markdown } : {}),
  };
  } catch (err) {
    if (!isCrashError(err)) throw err;
    // M13c: la pagina crasheo. Reviver: relanzar y RECAPTURAR la respuesta ya
    // generada (jamas reenviar el turno). Si no se puede probar, error nombrado.
    await reviveSession();
    const revived = await openSession(options).catch(() => undefined);
    if (revived) {
      await waitConversationSettle(revived.page).catch(() => {});
      const recaptured = (await readLastAssistant(revived.page).catch(() => "")).trim();
      if (recaptured && recaptured !== beforeText) {
        return { text: recaptured, ms: Math.round(performance.now() - t0), submitted: true, reused, url: revived.page.url() };
      }
    }
    throw new Error(`web_page_crashed: la pagina crasheo y no se pudo recapturar (${String(err).slice(0, 120)})`);
  }
}

/** Binario de Chrome segun el modo (para lanzar ventanas fuera de la sesion). */
export function chromeExecutable(which: "chrome" | "shell" = "chrome"): string {
  return which === "shell" ? shellBinary() : CHROME_BINARY;
}

/**
 * Corre fn con la pestana headless (lanzandola si hace falta). El llamador
 * debe estar dentro de withWebLock: la pestana es compartida.
 */
export async function withSessionPage<T>(options: WebTurnOptions, fn: (page: Page) => Promise<T>): Promise<T> {
  const { page } = await openSession(options);
  return fn(page);
}

/** Cierra la sesion perezosa (tests, scripts, apagado). */
export async function closeWebSession(): Promise<void> {
  if (!session) return;
  const current = session;
  session = undefined;
  await current.browser.close().catch(() => {});
}