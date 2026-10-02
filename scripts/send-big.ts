#!/usr/bin/env bun
// send-big.ts — prueba del fallback "un solo txt monstruoso":
// manda un archivo ENTERO como UN mensaje por el transporte de pestana
// persistente y verifica que llego completo con un token al final.
//
//   bun run scripts/send-big.ts --file ~/Development/TEXTOSSSS.txt
//   bun run scripts/send-big.ts --file ... --browser shell
import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const file = argValue("--file");
const which = argValue("--browser") ?? "chrome";
const statePath = join(homedir(), ".codex-web-http", "storage-state.json");
if (!file || !existsSync(file)) {
  console.error("--file <ruta> requerido y debe existir");
  process.exit(2);
}
const content = readFileSync(file, "utf8");
const nonce = `NB-${crypto.randomUUID().slice(0, 8)}`;
const prompt = `INSTRUCCION: responde SOLO con el token que aparece entre <<<>>> al final del texto siguiente.\n\n${content}\n<<<${nonce}>>>`;

function shellBinary(): string {
  const base = join(homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(base).filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse();
  for (const dir of dirs) {
    const bin = join(base, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(bin)) return bin;
  }
  throw new Error("sin headless shell");
}
const executablePath = which === "shell" ? shellBinary() : "/usr/bin/google-chrome";
function chromeVersion(): string {
  try {
    const out = Bun.spawnSync(["/usr/bin/google-chrome", "--version"]).stdout.toString();
    return /(\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1] ?? "153.0.0.0";
  } catch {
    return "153.0.0.0";
  }
}

const evidenceDir = join(import.meta.dir, "..", "probe", "evidence");
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidencePath = join(evidenceDir, `send-big-${stamp}.md`);
const lines: string[] = [];
lines.push(`# send-big @ ${new Date().toISOString()}`);
lines.push(`file: ${file} (${content.length} chars, ${Buffer.byteLength(content, "utf8")} bytes)`);
lines.push(`prompt total: ${Buffer.byteLength(prompt, "utf8")} bytes`);
lines.push(`nonce esperado: ${nonce}`);
lines.push("");

let browser: Browser | undefined;
let page: Page | undefined;
let ok = false;
try {
  browser = await chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: which !== "shell",
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    storageState: statePath,
    locale: "es-ES",
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion()} Safari/537.36`,
    viewport: { width: 1280, height: 800 },
  });
  page = await context.newPage();
  const t0 = performance.now();
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const composer = page.locator('#prompt-textarea, div[contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  console.log(`composer listo; mandando ${content.length} chars como UN mensaje...`);

  const tSend = performance.now();
  await composer.click();
  await composer.fill(prompt);
  await page.waitForTimeout(600);
  const filledOk = (await composer.innerText()).length >= prompt.length * 0.9;
  await page.keyboard.press("Enter");
  let submitted = false;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500);
    const now = await composer.innerText().catch(() => "");
    if (!now.trim()) {
      submitted = true;
      break;
    }
  }
  console.log(`filled_ok=${filledOk} submitted=${submitted}`);

  const textOf = () => page.evaluate(() => document.querySelector("main")?.innerText ?? "");
  const markerCount = (t: string) => (t.match(/ChatGPT dijo:|ChatGPT said:/gi) ?? []).length;
  const beforeMarkers = markerCount(await textOf());
  let text = "";
  let stable = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const current = await textOf();
    if (markerCount(current) > beforeMarkers && current === text) {
      stable++;
      if (stable >= 3) break;
    } else {
      stable = 0;
    }
    text = current;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const ms = Math.round(performance.now() - tSend);
  const markers = ["ChatGPT dijo:", "ChatGPT said:"];
  const idx = Math.max(...markers.map((m) => text.lastIndexOf(m)));
  let response = idx >= 0 ? text.slice(idx + markers[0].length) : "";
  const cut = response.search(/(ChatGPT puede cometer errores|ChatGPT can make mistakes|Última respuesta|Tú dijiste:|You said:)/i);
  if (cut > 0) response = response.slice(0, cut);
  response = response.trim();
  ok = submitted && response.includes(nonce);

  lines.push(`startup+envio: ${Math.round(tSend - t0)}ms`);
  lines.push(`filled_ok: ${filledOk} | submitted: ${submitted}`);
  lines.push(`espera_respuesta: ${ms}ms`);
  lines.push(`respuesta (200): ${response.slice(0, 200).replace(/\n/g, " ")}`);
  lines.push(`nonce presente: ${response.includes(nonce)}`);
  lines.push(`VERDICT: ${ok ? "PASS" : "FAIL"}`);
  console.log(`respuesta en ${ms}ms: "${response.slice(0, 80).replace(/\n/g, " ")}"`);
  console.log(`nonce presente: ${response.includes(nonce)}`);
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  lines.push(`ERROR: ${message}`);
  console.log(`ERROR: ${message}`);
} finally {
  writeFileSync(evidencePath, lines.join("\n") + "\n", { mode: 0o600 });
  console.log(`evidencia: ${evidencePath}`);
  if (browser) await browser.close().catch(() => {});
}
process.exit(ok ? 0 : 1);
