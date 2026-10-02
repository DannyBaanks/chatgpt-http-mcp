#!/usr/bin/env bun
// inspect-dom.ts — descubre los selectores reales de la UI actual de ChatGPT.
// Solo lectura: abre una conversacion existente y cuenta estructuras.
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] ?? "https://chatgpt.com/";
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
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(8_000);

// Si estamos en el home, enumerar conversaciones DENTRO de la pagina
// (fetch autenticado, sin Cloudflare) y abrir la primera (solo lectura).
if (new URL(page.url()).pathname === "/") {
  const convList = await page.evaluate(async () => {
    const res = await fetch("/backend-api/conversations?offset=0&limit=5&order=updated", {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { status: res.status, ids: [] as string[] };
    const json = (await res.json()) as { items?: Array<{ id?: string }> };
    return { status: res.status, ids: (json.items ?? []).map((i) => i.id ?? "").filter(Boolean) };
  });
  console.log(`conversations api: status=${convList.status} ids=${convList.ids.length}`);
  const first = convList.ids[0];
  if (first) {
    console.log(`abriendo conversacion ${first.slice(0, 8)}...`);
    await page.goto(`https://chatgpt.com/c/${first}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(12_000);
  }
}

const info = await page.evaluate(() => {
  const count = (selector: string) => document.querySelectorAll(selector).length;
  const roles: Record<string, number> = {};
  document.querySelectorAll("[data-message-author-role]").forEach((el) => {
    const role = el.getAttribute("data-message-author-role") ?? "?";
    roles[role] = (roles[role] ?? 0) + 1;
  });
  const testids: Record<string, number> = {};
  document.querySelectorAll("[data-testid]").forEach((el) => {
    const id = (el.getAttribute("data-testid") ?? "?").replace(/\d+/g, "N");
    testids[id] = (testids[id] ?? 0) + 1;
  });
  const turnIds = Array.from(document.querySelectorAll("[data-turn-id]")).map((el) =>
    (el.getAttribute("data-turn-id") ?? "").slice(0, 24),
  );
  const lastAssistant =
    document.querySelector('[data-message-author-role="assistant"]')?.textContent?.slice(0, 120) ?? "";
  return {
    title: document.title,
    url: location.href,
    roles,
    testidsTop: Object.entries(testids)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15),
    turnIdsCount: turnIds.length,
    turnIdsSample: turnIds.slice(0, 5),
    articleTurns: count('article[data-testid^="conversation-turn"]'),
    composer: count('#prompt-textarea, div[contenteditable="true"]'),
    lastAssistant,
  };
});

const shot = join(evidenceDir, `dom-${stamp}.png`);
await page.screenshot({ path: shot, fullPage: false });
const out = join(evidenceDir, `dom-${stamp}.md`);
writeFileSync(out, `# DOM inspect\n\n${JSON.stringify(info, null, 2)}\n\nscreenshot: ${shot}\n`, {
  mode: 0o600,
});
console.log(`url=${info.url}`);
console.log(`title=${info.title} composer=${info.composer} article-turns=${info.articleTurns}`);
console.log(`roles=${JSON.stringify(info.roles)}`);
console.log(`turn-ids=${info.turnIdsCount} sample=${JSON.stringify(info.turnIdsSample)}`);
console.log(`testids top=${JSON.stringify(info.testidsTop)}`);
console.log(`lastAssistant="${info.lastAssistant}"`);
console.log(`evidencia=${out}`);
await browser.close();
