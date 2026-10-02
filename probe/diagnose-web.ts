#!/usr/bin/env bun
// diagnose-web.ts — ¿qué ve el browser headless con el storageState importado?
// Solo diagnostica (screenshot + señales), no interactúa con la cuenta.
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const which = process.argv.includes("--shell") ? "shell" : "chrome";
const statePath = join(homedir(), ".codex-web-http", "storage-state.json");
const evidenceDir = join(import.meta.dir, "evidence");
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

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

const stealth = process.argv.includes("--stealth");
const version = "153.0.8010.48";
const normalUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
const browser = await chromium.launch({
  executablePath,
  headless: true,
  ...(stealth
    ? {
        chromiumSandbox: true,
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--disable-blink-features=AutomationControlled"],
      }
    : {}),
});
const context = await browser.newContext({
  storageState: statePath,
  locale: "es-ES",
  ...(stealth ? { userAgent: normalUA } : {}),
});
const page = await context.newPage();
await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await new Promise((r) => setTimeout(r, 12_000));

const info = await page.evaluate(() => {
  const text = document.body?.innerText ?? "";
  return {
    url: location.href,
    title: document.title,
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    hasComposer:
      !!document.querySelector('#prompt-textarea') ||
      !!document.querySelector('div[contenteditable="true"]'),
    hasLoginButton:
      !!document.querySelector('[data-testid="login-button"]') ||
      !!document.querySelector('a[href="/auth/login"]'),
    challenge:
      /just a moment|enable javascript|verify you are human|un momento|comprobando/i.test(text),
    loginText: /inicia sesión|log in|sign up|crear cuenta/i.test(text),
    bodyHead: text.slice(0, 300).replace(/\n+/g, " "),
  };
});
const shot = join(evidenceDir, `diag-${which}-${stamp}.png`);
await page.screenshot({ path: shot, fullPage: false });
const out = join(evidenceDir, `diag-${which}-${stamp}.md`);
writeFileSync(
  out,
  [
    `# diagnose ${which} @ ${new Date().toISOString()}`,
    `binary: ${executablePath}`,
    `url: ${info.url}`,
    `title: ${info.title}`,
    `ua: ${info.ua}`,
    `webdriver: ${info.webdriver}`,
    `composer: ${info.hasComposer} | login button: ${info.hasLoginButton}`,
    `challenge: ${info.challenge} | texto login: ${info.loginText}`,
    `screenshot: ${shot}`,
    "",
    "body head:",
    info.bodyHead,
  ].join("\n") + "\n",
  { mode: 0o600 },
);
console.log(`[${which}] url=${info.url}`);
console.log(`[${which}] title="${info.title}" composer=${info.hasComposer} login=${info.hasLoginButton} challenge=${info.challenge} webdriver=${info.webdriver}`);
console.log(`[${which}] ua=${info.ua}`);
console.log(`[${which}] evidencia=${out}`);
console.log(`[${which}] screenshot=${shot}`);
await browser.close();
