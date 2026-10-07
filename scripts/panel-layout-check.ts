#!/usr/bin/env bun
// panel-layout-check.ts — T11: el panel no desborda en horizontal (escritorio
// y movil, pestanas Chat y Estado) y la UI no expone secretos. Siembra chats
// de prueba en un CODEX_WEB_HTTP_HOME temporal (no toca el real), levanta el
// panel sin bridge y lo abre con Chrome via playwright-core.
//
//   bun run scripts/panel-layout-check.ts [dir-capturas]
// Sale 0 si todo cuadra; imprime un JSON con las medidas.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const shots = process.argv[2];
const home = mkdtempSync(join(tmpdir(), "isymcp-layout-"));
process.env.CODEX_WEB_HTTP_HOME = home;
const { createChat, saveChat } = await import("../src/chats");
const { startPanel } = await import("../src/panel");

const long = "palabra".repeat(40);
const a = createChat("Prueba de render con un titulo bastante largo para la barra lateral");
a.conversation_url = "https://chatgpt.com/c/0000aaaa-1111-2222-3333-444455556666";
a.messages = [
  { role: "user", text: `hola, una url larguisima https://example.com/${long} y <script>alert(1)</script>`, ts: new Date().toISOString() },
  { role: "assistant", ts: new Date().toISOString(), meta: { ms: 38_400, url: a.conversation_url },
    text: "Claro. **Negritas**, `codigo`, y una lista:\n\n- uno\n- dos\n\n```ts\nconst muyLarga = \"" + long + "\";\n```\n<img src=x onerror=alert(2)>" },
  { role: "error", ts: new Date().toISOString(), text: "Esta llamada a la herramienta se ha bloqueado por los controles de seguridad de OpenAI.", meta: { kind: "provider_blocked", ms: 18_000 } },
];
saveChat(a);
saveChat({ ...createChat(), title: "Segundo chat" });

const server = startPanel(0, "1"); // bridge en puerto 1: apagado a proposito
const base = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: process.env.CODEX_WEB_HTTP_CHROME || "/usr/bin/google-chrome", headless: true });
const results: Array<Record<string, unknown>> = [];
let alerts = 0;
try {
  for (const [label, width, height] of [["desktop", 1400, 900], ["mobile", 390, 844]] as const) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on("dialog", async (d) => { alerts++; await d.dismiss(); });
    await page.goto(`${base}/#chat`);
    // En movil la lista es un drawer: se abre como lo haria el usuario.
    if (width < 980) { await page.click("#btn-side"); await page.waitForTimeout(300); }
    await page.locator(".chatlist button", { hasText: "Prueba de render" }).click();
    await page.waitForSelector(".msg.assistant .body");
    for (const tab of ["chat", "estado"] as const) {
      await page.evaluate((t) => { location.hash = t; }, tab);
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        scripts: document.querySelectorAll(".msgs script, .msgs img").length,
      }));
      results.push({ label, tab, ...m, overflow: m.scrollWidth > m.innerWidth });
      if (shots) await page.screenshot({ path: join(shots, `${label}-${tab}.png`) });
    }
    if (label === "mobile" && shots) {
      await page.evaluate(() => { location.hash = "chat"; });
      await page.click("#btn-side");
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shots, "mobile-drawer.png") });
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
}
const ok = results.every((r) => !r.overflow && r.scripts === 0) && alerts === 0;
console.log(JSON.stringify({ ok, alerts, results }, null, 2));
process.exit(ok ? 0 : 1);
