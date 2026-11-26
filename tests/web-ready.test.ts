import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { defaultBrowserExecutable } from "../src/platform/browser";
import { waitForChatGPTComposer } from "../src/web-ready";
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: defaultBrowserExecutable(), headless: true }); }, 60000);
afterAll(async () => { await browser?.close(); });
test("logged-out bootstrap is classified before waiting for a missing composer", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<script id="client-bootstrap" type="application/json">{"authStatus":"logged_out","session":null}</script>');
    await expect(waitForChatGPTComposer(page, 5000)).rejects.toThrow("web_session_expired");
  } finally { await page.close(); }
});
test("a hidden editor does not mask a visible composer", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div contenteditable="true" hidden></div><div contenteditable="true" id="prompt-textarea">ready</div>');
    await expect(waitForChatGPTComposer(page, 5000)).resolves.toBeUndefined();
  } finally { await page.close(); }
});
