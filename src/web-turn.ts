// web-turn.ts — M7: transporte Web reutilizable (browser persistente).
//
// Extrae la logica probada en scripts/e2e-web.ts (M4-B) a un modulo con una
// sesion LAZY y reutilizada: se lanza el browser la primera vez y la misma
// pestana atiende todos los turnos siguientes. Eso es lo que hace comparables
// los turnos del e2e con los de un servidor.
//
// Sin sesion/cookies no inventa nada: devuelve error nombrado.
import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WebTurnResult {
  text: string;
  ms: number;
  submitted: boolean;
  reused: boolean;
  url: string;
}

export interface WebTurnOptions {
  statePath?: string;
  browser?: "chrome" | "shell";
  headed?: boolean;
  settleMs?: number;
  deadlineMs?: number;
  /** Si ya hay un chat /c/, no abre otro. */
  conversationUrl?: string;
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
const normalUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion("/usr/bin/google-chrome")} Safari/537.36`;

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

async function openSession(options: WebTurnOptions): Promise<{ browser: Browser; page: Page }> {
  const which = options.browser ?? "chrome";
  const statePath = options.statePath ?? join(homedir(), ".codex-web-http", "storage-state.json");
  if (!existsSync(statePath)) {
    throw new Error(`web_session_missing: no existe ${statePath}; corre scripts/import-cookies.ts`);
  }
  const key = `${which}|${statePath}|${options.headed ? "headed" : "headless"}`;
  if (session && session.key === key) return session;

  const executablePath = which === "shell" ? shellBinary() : "/usr/bin/google-chrome";
  if (!existsSync(executablePath)) {
    throw new Error(`web_browser_missing: binario no encontrado: ${executablePath}`);
  }
  if (session) await session.browser.close().catch(() => {});
  const browser = await chromium.launch({
    executablePath,
    headless: !options.headed,
    // El headless shell no soporta el sandbox de Chrome; el Chrome completo si.
    chromiumSandbox: which !== "shell",
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    storageState: statePath,
    locale: "es-ES",
    userAgent: normalUA,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
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
export async function sendWebTurn(prompt: string, options: WebTurnOptions = {}): Promise<WebTurnResult> {
  if (!prompt.trim()) throw new Error("web_empty_prompt: prompt vacio");
  const reused = Boolean(session);
  const { page } = await openSession(options);
  const settleMs = options.settleMs ?? 1_000;
  const deadlineMs = options.deadlineMs ?? 90_000;
  const composer = page.locator('#prompt-textarea, div[contenteditable="true"]').first();
  const t0 = performance.now();

  // Submit robusto: el primer envio puede no registrar. Verifica que el
  // composer se vacie; si no, usa el boton de enviar; hasta 3 intentos.
  let submitted = false;
  for (let attempt = 1; attempt <= 3 && !submitted; attempt++) {
    await composer.click();
    await composer.fill(prompt);
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(500);
      const now = await composer.innerText().catch(() => "");
      if (!now.trim()) { submitted = true; break; }
    }
    if (!submitted) {
      const send = page
        .locator('button[data-testid="send-button"], button[aria-label*="Enviar"], button[aria-label*="Send"]')
        .first();
      if ((await send.count()) > 0 && (await send.isEnabled().catch(() => false))) {
        await send.click().catch(() => {});
      }
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(500);
        const now = await composer.innerText().catch(() => "");
        if (!now.trim()) { submitted = true; break; }
      }
    }
  }
  if (!submitted) {
    return { text: "", ms: Math.round(performance.now() - t0), submitted: false, reused, url: page.url() };
  }

  // La UI actual no expone data-message-author-role: se espera la marca
  // textual del asistente y se exige texto estable (fin de streaming).
  const textOf = () => page.evaluate(() => document.querySelector("main")?.innerText ?? "");
  const markerCount = (t: string) => (t.match(/ChatGPT dijo:|ChatGPT said:/gi) ?? []).length;
  const beforeMarkers = markerCount(await textOf());
  let text = "";
  let stable = 0;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const current = await textOf();
    const responded = markerCount(current) > beforeMarkers;
    if (responded && current === text) {
      stable++;
      if (stable * settleMs >= 3_000) break;
    } else {
      stable = 0;
    }
    text = current;
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  return {
    text: extractResponse(text),
    ms: Math.round(performance.now() - t0),
    submitted: true,
    reused,
    url: page.url(),
  };
}

/** Cierra la sesion perezosa (tests, scripts, apagado). */
export async function closeWebSession(): Promise<void> {
  if (!session) return;
  const current = session;
  session = undefined;
  await current.browser.close().catch(() => {});
}