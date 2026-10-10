import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import * as settings from "../src/chatgpt-settings";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CODEX_WEB_HTTP_CHROME || "/usr/bin/google-chrome", headless: true }); });
afterAll(async () => { await browser?.close(); });

// Local DOM boundary fixture: no account, network request, cookies or model.
async function composer(): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(`<button aria-label="Other Model settings">unrelated</button>
    <form><div contenteditable="true" id="prompt-textarea"></div>
    <button type="button" disabled aria-haspopup="menu" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning">Medium</button></form>
    <div role="menu" hidden><div data-model-picker-view="simple">
    <div role="menuitem" data-model-picker-view-toggle="true" tabindex="0" aria-label="Seleccionar modelo">Medium</div>
    <div data-model-choices aria-hidden="true" inert><div role="menuitemradio" aria-checked="true">GPT-6</div><div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div></div>
    <div role="menuitem" data-reasoning-slider="true" tabindex="0" aria-label="Potencia">Potencia<span role="slider" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1" aria-valuetext="Medium"></span></div></div></div>
    <script>
    const trigger=document.querySelector('form button'),menu=document.querySelector('[role="menu"]');
    setTimeout(()=>trigger.disabled=false,100);
    trigger.onclick=()=>{menu.hidden=!menu.hidden;trigger.setAttribute('aria-expanded',String(!menu.hidden));trigger.setAttribute('data-opened','true')};
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;trigger.setAttribute('aria-expanded','false')}});
    const view=menu.querySelector('[data-model-picker-view]'),choices=menu.querySelector('[data-model-choices]'),power=menu.querySelector('[data-reasoning-slider]');
    menu.querySelector('[data-model-picker-view-toggle]').onclick=()=>{view.setAttribute('data-model-picker-view','advanced');choices.inert=false;choices.setAttribute('aria-hidden','false');power.hidden=true;trigger.setAttribute('data-model-expanded','true')};
    for(const row of menu.querySelectorAll('[role="menuitemradio"]'))row.onclick=()=>{for(const r of menu.querySelectorAll('[role="menuitemradio"]'))r.setAttribute('aria-checked',String(r===row));view.setAttribute('data-model-picker-view','simple');choices.inert=true;choices.setAttribute('aria-hidden','true');power.hidden=false};
    menu.querySelector('[data-reasoning-slider]').onkeydown=e=>{if(e.key==='ArrowRight'){const slider=menu.querySelector('[role="slider"]');slider.setAttribute('aria-valuenow','2');slider.setAttribute('aria-valuetext','High');trigger.textContent='High'}};
    </script>`);
  return page;
}

test("settings read waits for the usable composer control and ignores model buttons outside its form", async () => {
  const page = await composer();
  try {
    expect(await settings.readComposerSettings(page, { timeoutMs: 1000 })).toMatchObject({ model: "GPT-6", effort: "Medium", effortPosition: 2, effortSteps: 3 });
    expect(await page.locator('form button').getAttribute('data-opened')).toBe("true");
    expect(await page.locator('[role="menu"]').isVisible()).toBe(false);
  } finally { await page.close(); }
}, 20000);

test("explicit model selection sets High and confirms the exact model in the composer", async () => {
  const page = await composer();
  try {
    expect(await settings.selectComposerSettings(page, "GPT-5.6 Sol", "high", { timeoutMs: 3000 })).toMatchObject({ model: "GPT-5.6 Sol", effort: "High", effortPosition: 3, effortSteps: 3 });
    expect(await page.locator('form button').getAttribute('data-model-expanded')).toBe("true");
    expect(await page.locator('[role="menu"]').isVisible()).toBe(false);
  } finally { await page.close(); }
});

test("an unavailable requested model fails without selecting a different model", async () => {
  const page = await composer();
  try {
    let failure: unknown;
    try { await settings.selectComposerSettings(page, "GPT-unknown", "high", { timeoutMs: 3000 }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("web_model_unavailable");
    expect(await page.evaluate(() => document.querySelector('[aria-checked="true"]')?.textContent)).toBe("GPT-6");
    expect(await page.locator('[role="menu"]').isVisible()).toBe(false);
  } finally { await page.close(); }
}, 10000);
