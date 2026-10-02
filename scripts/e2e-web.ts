#!/usr/bin/env bun
// e2e-web.ts — M4-B: turnos Web reales con UNA sola pestana persistente.
//
// Mide por turno: ms, respuesta, y PSS del arbol del browser. No cierra la
// pestana entre turnos (el punto del milestone). Evidencia en probe/evidence/.
//
//   bun run scripts/e2e-web.ts --turns 3
//   bun run scripts/e2e-web.ts --turns 3 --browser shell
//   bun run scripts/e2e-web.ts --turns 1 --headed
import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const turns = Number(argValue("--turns") ?? "3");
const headed = process.argv.includes("--headed");
const which = argValue("--browser") ?? "chrome";
const statePath = argValue("--state") ?? join(homedir(), ".codex-web-http", "storage-state.json");

if (!Number.isInteger(turns) || turns < 1 || turns > 10) {
  console.error("--turns debe ser 1..10");
  process.exit(2);
}
if (!existsSync(statePath)) {
  console.error(`No existe ${statePath}. Corre scripts/import-cookies.ts primero.`);
  process.exit(2);
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

const executablePath = which === "shell" ? shellBinary() : "/usr/bin/google-chrome";
if (!existsSync(executablePath)) {
  console.error(`binario no encontrado: ${executablePath}`);
  process.exit(2);
}

// Cloudflare rechaza HeadlessChrome + navigator.webdriver. Este combo pasa:
// UA del Chrome real (cf_clearance esta atado a ese UA), sin --enable-automation
// y con la feature AutomationControlled apagada.
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
function extractResponse(main: string): string {
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

/** PSS (kB) y cantidad de procesos del subarbol del proceso actual. */
function pssTree(): { mb: number; procs: number } {
  const children = (pid: number): number[] => {
    try {
      const out = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString();
      return out.split(/\s+/).filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };
  const pids: number[] = [];
  const stack = [process.pid];
  while (stack.length) {
    const pid = stack.pop()!;
    pids.push(pid);
    stack.push(...children(pid));
  }
  let kb = 0;
  for (const pid of pids) {
    try {
      const text = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
      const m = /^Pss:\s+(\d+)/m.exec(text);
      if (m) kb += Number(m[1]);
    } catch {
      /* proceso ya cerrado */
    }
  }
  return { mb: Math.round(kb / 1024), procs: pids.length };
}

const evidenceDir = join(import.meta.dir, "..", "probe", "evidence");
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidencePath = join(evidenceDir, `web-turns-${stamp}.md`);
const lines: string[] = [];
lines.push(`# M4-B web turns @ ${new Date().toISOString()}`);
lines.push(`browser: ${which} (${executablePath})`);
lines.push(`headless: ${!headed}`);
lines.push(`state: ${statePath}`);
lines.push("");

let browser: Browser | undefined;
let page: Page | undefined;
let failures = 0;
const startedAt = performance.now();

try {
  browser = await chromium.launch({
    executablePath,
    headless: !headed,
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
  page = await context.newPage();

  const t0 = performance.now();
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const composer = page.locator('#prompt-textarea, div[contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  const loggedIn = (await page.locator('[data-testid="login-button"], a[href="/auth/login"]').count()) === 0;
  const startupMs = Math.round(performance.now() - t0);
  const afterStartup = pssTree();
  lines.push(`startup: ${startupMs}ms | logged_in_composer=${loggedIn} | pss=${afterStartup.mb}MB procs=${afterStartup.procs}`);
  console.log(`startup ${startupMs}ms | sesion=${loggedIn ? "ok" : "NO"} | PSS=${afterStartup.mb}MB procs=${afterStartup.procs}`);
  if (!loggedIn) {
    lines.push("ABORT: la sesion no aparece logueada (cookies vencidas o bloqueadas).");
    failures++;
  } else {
    for (let turn = 1; turn <= turns; turn++) {
      const prompt = `Responde exactamente: turno ${turn} ok`;
      const tSend = performance.now();
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
        if (!submitted) console.log(`  (turno ${turn}: intento ${attempt} sin submit, reintento)`);
      }

      // La UI actual no expone data-message-author-role: se espera la marca
      // textual del asistente y se exige texto estable (fin de streaming).
      const textOf = () => page.evaluate(() => document.querySelector("main")?.innerText ?? "");
      const markerCount = (t: string) => (t.match(/ChatGPT dijo:|ChatGPT said:/gi) ?? []).length;
      const beforeMarkers = markerCount(await textOf());
      let text = "";
      let stable = 0;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const current = await textOf();
        const responded = markerCount(current) > beforeMarkers;
        if (responded && current === text) {
          stable++;
          if (stable >= 3) break;
        } else {
          stable = 0;
        }
        text = current;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const ms = Math.round(performance.now() - tSend);
      const response = extractResponse(text);
      const ok = response.toLowerCase().includes(`turno ${turn} ok`);
      const pss = pssTree();
      lines.push(`## turno ${turn}`);
      lines.push(`prompt: ${prompt}`);
      lines.push(`submitted: ${submitted}`);
      lines.push(`ms: ${ms} | ok: ${ok} | pss: ${pss.mb}MB procs=${pss.procs}`);
      lines.push(`url: ${page.url()}`);
      lines.push(`respuesta (primeros 300): ${response.slice(0, 300).replace(/\n/g, " ")}`);
      lines.push(`pestana: mismo page object reutilizado (no se cerro entre turnos)`);
      lines.push("");
      console.log(
        `turno ${turn}: ${ms}ms ok=${ok} PSS=${pss.mb}MB procs=${pss.procs} respuesta="${response.slice(0, 60).replace(/\n/g, " ")}"`,
      );
      if (!ok) failures++;
    }
  }
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  lines.push(`ERROR: ${message}`);
  console.log(`ERROR: ${message}`);
  failures++;
} finally {
  const totalMs = Math.round(performance.now() - startedAt);
  lines.push(`total: ${totalMs}ms | fallos: ${failures}`);
  writeFileSync(evidencePath, lines.join("\n") + "\n", { mode: 0o600 });
  console.log(`evidencia: ${evidencePath}`);
  if (browser) await browser.close().catch(() => {});
}

process.exit(failures === 0 ? 0 : 1);
