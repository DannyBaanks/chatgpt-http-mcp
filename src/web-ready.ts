import type { Page } from "playwright-core";

/** Wait for the owned composer or the explicit authentication state. A missing
 * editor on the logged-out shell is a session error, not a capture timeout. */
export async function waitForChatGPTComposer(page: Page, timeoutMs = 60_000): Promise<void> {
  const state = await page.waitForFunction(() => {
    const bootstrap = document.getElementById("client-bootstrap");
    if (bootstrap?.textContent) {
      try {
        if (JSON.parse(bootstrap.textContent).authStatus === "logged_out") return "logged_out";
      } catch { /* hydration may not have finished writing the bootstrap */ }
    }
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    if (Array.from(document.querySelectorAll('[data-testid="login-button"], a[href="/auth/login"]')).some(visible)) return "logged_out";
    if (Array.from(document.querySelectorAll('#prompt-textarea, div[contenteditable="true"]')).some(visible)) return "ready";
    return false;
  }, undefined, { timeout: timeoutMs });
  try {
    if (await state.jsonValue() === "logged_out")
      throw Error("web_session_expired: ChatGPT no aparece logueado; renueva la sesion con bun run login en el repositorio de ISyMCP");
  } finally { await state.dispose(); }
}
