#!/usr/bin/env bun
// send-and-inspect.ts — manda UNA vez "ok" con el flujo stealth y dumpea el
// DOM para descubrir los selectores reales de mensajes en la UI actual.
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const statePath = join(homedir(), ".codex-web-http", "storage-state.json");
const evidenceDir = join(import.meta.dir, "evidence");
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  chromiumSandbox: true,
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  storageState: statePath,
  locale: "es-ES",
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Safari/537.36",
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
const composer = page.locator('#prompt-textarea, div[contenteditable="true"]').first();
await composer.waitFor({ state: "visible", timeout: 60_000 });
console.log("composer listo, mandando 'ok'...");
await composer.click();
await composer.fill("Responde exactamente: ok");
await page.keyboard.press("Enter");
await page.waitForTimeout(20_000);

const info = await page.evaluate(async () => {
  const count = (sel: string) => document.querySelectorAll(sel).length;
  const roles: Record<string, number> = {};
  document.querySelectorAll("[data-message-author-role]").forEach((el) => {
    const r = el.getAttribute("data-message-author-role") ?? "?";
    roles[r] = (roles[r] ?? 0) + 1;
  });
  const testids: Record<string, number> = {};
  document.querySelectorAll("[data-testid]").forEach((el) => {
    const id = (el.getAttribute("data-testid") ?? "?").replace(/\d+/g, "N");
    testids[id] = (testids[id] ?? 0) + 1;
  });
  const turnIds = Array.from(document.querySelectorAll("[data-turn-id]")).map((el) =>
    (el.getAttribute("data-turn-id") ?? "").slice(0, 20),
  );
  let convShape = "n/a";
  try {
    const res = await fetch("/backend-api/conversations?offset=0&limit=3&order=updated", {
      headers: { accept: "application/json" },
    });
    const json = (await res.json()) as Record<string, unknown>;
    convShape = `status=${res.status} keys=${Object.keys(json).join(",")} items=${
      Array.isArray((json as { items?: unknown[] }).items) ? (json as { items: unknown[] }).items.length : "no-array"
    }`;
  } catch (e) {
    convShape = `error ${String(e)}`;
  }
  const main = document.querySelector("main")?.innerText ?? document.body.innerText;
  return {
    url: location.href,
    roles,
    turnIdsCount: turnIds.length,
    turnIdsSample: turnIds.slice(0, 4),
    articles: count('article[data-testid^="conversation-turn"]'),
    anyConversationTurn: count('[data-testid^="conversation-turn"]'),
    testidsTop: Object.entries(testids)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12),
    mainText: main.slice(0, 400).replace(/\n+/g, " | "),
    convShape,
  };
});

const shot = join(evidenceDir, `send-${stamp}.png`);
await page.screenshot({ path: shot, fullPage: false });
const out = join(evidenceDir, `send-${stamp}.md`);
writeFileSync(out, `${JSON.stringify(info, null, 2)}\n\nscreenshot: ${shot}\n`, { mode: 0o600 });
console.log(`url=${info.url}`);
console.log(`roles=${JSON.stringify(info.roles)} turnIds=${info.turnIdsCount} articles=${info.articles}`);
console.log(`testids=${JSON.stringify(info.testidsTop)}`);
console.log(`api: ${info.convShape}`);
console.log(`texto: ${info.mainText}`);
console.log(`evidencia=${out}`);
await browser.close();
