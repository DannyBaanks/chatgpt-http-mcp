import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { defaultBrowserExecutable } from "../src/platform/browser";

const browserExecutable = defaultBrowserExecutable();
const browserAvailable = Boolean(browserExecutable && existsSync(browserExecutable));

if (!browserAvailable) {
  test.skip("panel chat browser E2E (requiere Chrome o Edge local)", () => {});
} else {
  const bridgeToken = "isymcp-panel-e2e-fake-bridge-token";
  const runningToolCard = {
    tool: "test.fake_tool",
    summary: "E2E synthetic fixture only; no command executed",
    state: "running" as const,
    correlation: "legacy" as const,
  };
  const savedToolCard = { ...runningToolCard, state: "ok" as const, exit_code: 0, duration_ms: 4 };

  let root = "";
  let home = "";
  let workspace = "";
  let previousHome: string | undefined;
  let previousToken: string | undefined;
  let bridge: ReturnType<typeof Bun.serve>;
  let panel: ReturnType<typeof import("../src/panel").startPanel>;
  let browser: Browser;
  let page: Page;
  let sessionFp = "";
  let panelUrl = "";
  const activeToolChats = new Set<string>();
  const bridgeTurnRequests: Array<Record<string, unknown>> = [];
  const browserErrors: string[] = [];
  const browserRequests: string[] = [];
  const browserRequestDetails: Array<{ method: string; url: string }> = [];

  beforeAll(async () => {
    previousHome = process.env.CODEX_WEB_HTTP_HOME;
    previousToken = process.env.CODEX_WEB_HTTP_TOKEN;
    root = mkdtempSync(join(tmpdir(), "isymcp-panel-browser-e2e-"));
    home = join(root, "home");
    workspace = join(root, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    process.env.CODEX_WEB_HTTP_HOME = home;
    process.env.CODEX_WEB_HTTP_TOKEN = bridgeToken;

    const { loadConfig } = await import("../src/config");
    const { runChatTurn, chatStatus } = await import("../src/chat-turn");
    const { loadChat, saveChat, publicChat } = await import("../src/chats");
    const { mintSession } = await import("../src/codex-sessions");
    const { startPanel } = await import("../src/panel");
    const config = loadConfig({});
    mintSession(workspace, { label: "e2e-read-only", writable: false, ttlHours: 0 });
    sessionFp = (await import("../src/codex-sessions")).listUserSessions()[0]!.fp;

    bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (req.headers.get("x-isymcp-token") !== bridgeToken) {
          return Response.json({ error: { type: "unauthorized", message: "fake bridge auth rejected" } }, { status: 401 });
        }
        const url = new URL(req.url);
        if (url.pathname === "/health") return Response.json({ ok: true });
        if (url.pathname === "/api/metrics") return Response.json(null);
        if (url.pathname === "/isymcp/settings") return Response.json({ state: "idle", last: null, seen: null });
        if (url.pathname === "/isymcp/chat/status") {
          const status = chatStatus();
          const tools = status.chat_id && activeToolChats.has(status.chat_id) ? [runningToolCard] : status.tools;
          return Response.json({ ...status, ...(tools?.length ? { tools } : {}) });
        }
        if (url.pathname === "/isymcp/chat/turn" && req.method === "POST") {
          const body = await req.json() as Record<string, unknown>;
          bridgeTurnRequests.push(body);
          const chatId = String(body.chat_id ?? "");
          const message = String(body.message ?? "");
          if (message === "FAIL E2E preserve this text") {
            return Response.json({ error: { type: "fake_provider_failure", message: "Synthetic bridge failure for E2E" } }, { status: 502 });
          }
          const chatUrl = (id: string) => {
            const hex = id.slice(2);
            return `https://chatgpt.com/c/${hex.slice(0, 8)}-${hex.slice(8, 12)}-4aaa-8bbb-${hex.slice(0, 8)}${hex.slice(8, 12)}`;
          };
          const outcome = await runChatTurn(chatId, message, config, {
            send: async (prompt, options) => {
              options.onPhase?.("thinking");
              options.onProgress?.(`Respuesta sintética: ${message}`);
              if (message === "E2E evidence turn") {
                activeToolChats.add(chatId);
                await Bun.sleep(1_600);
                activeToolChats.delete(chatId);
              }
              return {
                text: `Respuesta sintética: ${message}`,
                ms: 4,
                submitted: true,
                reused: false,
                url: chatUrl(chatId),
              };
            },
          });
          if (outcome.ok && message === "E2E evidence turn") {
            const saved = loadChat(chatId)!;
            const assistant = saved.messages.at(-1)!;
            assistant.meta = { ...assistant.meta, tools_enabled: true, tools: [savedToolCard] };
            saveChat(saved);
            outcome.chat = loadChat(chatId)!;
            outcome.reply = outcome.chat.messages.at(-1)!;
          }
          return Response.json({ ok: outcome.ok, reply: outcome.reply, chat: publicChat(outcome.chat, false) });
        }
        return Response.json({ error: { type: "not_found", message: "fake bridge route missing" } }, { status: 404 });
      },
    });
    panel = startPanel(0, String(bridge.port));
    panelUrl = panel.url.href;
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("request", (request) => {
      browserRequests.push(request.url());
      browserRequestDetails.push({ method: request.method(), url: request.url() });
    });
    await page.addInitScript(() => {
      const trace: string[] = [];
      Object.defineProperty(window, "__isymcpChatSelectionTrace", { value: trace });
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "isymcp.chat") trace.push(value);
        return setItem.call(this, key, value);
      };
    });
    await page.goto(panelUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#input").waitFor({ state: "visible" });
  }, 30_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    panel?.stop(true);
    bridge?.stop(true);
    if (previousHome === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
    else process.env.CODEX_WEB_HTTP_HOME = previousHome;
    if (previousToken === undefined) delete process.env.CODEX_WEB_HTTP_TOKEN;
    else process.env.CODEX_WEB_HTTP_TOKEN = previousToken;
    if (root && root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  });

  test("panel E2E: chats, draft, session, receipts, activity, failures and responsive drawers", async () => {
    const screenshots = process.env.ISYMCP_PANEL_E2E_SCREENSHOTS_DIR;
    if (screenshots) mkdirSync(screenshots, { recursive: true });
    const snapshot = async (name: string) => {
      if (screenshots) await page.screenshot({ path: join(screenshots, name) });
    };
    const send = async (message: string) => {
      const responsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith("/messages") && response.request().method() === "POST",
      );
      await page.locator("#input").fill(message);
      await page.locator("#send").click();
      return responsePromise;
    };
    const waitForText = (selector: string, text: string) => page.waitForFunction(
      ({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text) ?? false,
      { selector, text },
      { timeout: 8_000 },
    );
    const waitForValue = async (selector: string, value: string) => {
      try {
        await page.waitForFunction(
          ({ selector, value }) => (document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null)?.value === value,
          { selector, value },
          { polling: 100, timeout: 30_000 },
        );
      } catch (error) {
        const pageState = await page.evaluate(() => ({
          inputValue: (document.querySelector("#input") as HTMLTextAreaElement | null)?.value ?? null,
          inputDisabled: (document.querySelector("#input") as HTMLTextAreaElement | null)?.disabled ?? null,
          activeChatId: localStorage.getItem("isymcp.chat"),
          selectionTrace: (window as Window & { __isymcpChatSelectionTrace?: string[] }).__isymcpChatSelectionTrace ?? [],
        }));
        const savedChat = pageState.activeChatId
          ? await (await fetch(new URL(`/api/chats/${pageState.activeChatId}`, panelUrl))).json()
          : null;
        const recentChatRequests = browserRequestDetails
          .filter(({ url }) => new URL(url).pathname.startsWith("/api/chats/"))
          .slice(-20)
          .map(({ method, url }) => `${method} ${new URL(url).pathname}`);
        throw new Error(`${String(error)}; draft state ${JSON.stringify({ ...pageState, savedDraft: savedChat?.draft ?? null, recentChatRequests })}`);
      }
    };
    const waitForDisabled = (selector: string, disabled: boolean) => page.waitForFunction(
      ({ selector, disabled }) => (document.querySelector(selector) as HTMLInputElement | HTMLButtonElement | null)?.disabled === disabled,
      { selector, disabled },
      { timeout: 8_000 },
    );
    const waitForFocus = (selector: string) => page.waitForFunction(
      (selector) => document.querySelector(selector) === document.activeElement,
      selector,
      { timeout: 8_000 },
    );
    const assertNoHorizontalOverflow = async (width: number) => {
      const measured = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
      expect(measured.viewport).toBe(width);
      expect(measured.document).toBeLessThanOrEqual(measured.viewport);
    };

    await assertNoHorizontalOverflow(1440);
    await page.locator("#newchat").click();
    const seedResponse = await send("Seed chat A");
    if (seedResponse.status() !== 200) throw new Error(`Seed chat failed: HTTP ${seedResponse.status()} ${await seedResponse.text()}`);
    await waitForText("#msgs .msg.assistant .body:not(.live-body)", "Respuesta sintética: Seed chat A");
    const chatId = await page.evaluate(() => localStorage.getItem("isymcp.chat"));
    expect(chatId).toMatch(/^c_[0-9a-f]{16}$/);
    let releaseQueuedWrite!: () => void;
    let queuedWriteHeld!: () => void;
    const queuedWriteGate = new Promise<void>((resolve) => { releaseQueuedWrite = resolve; });
    const queuedWriteArrived = new Promise<void>((resolve) => { queuedWriteHeld = resolve; });
    let draftRequests = 0;
    const draftRoute = `${new URL(panelUrl).origin}/api/chats/${chatId}/draft`;
    await page.route(draftRoute, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      draftRequests++;
      if (draftRequests === 1) {
        queuedWriteHeld();
        await queuedWriteGate;
      }
      await route.continue();
    });
    await page.locator("#input").fill("Draft A old queued write");
    await queuedWriteArrived;
    await page.locator("#input").fill("Draft A survives a chat switch and reload");
    const pagehideWrite = page.waitForResponse((response) => {
      if (!new URL(response.url()).pathname.endsWith("/draft") || response.request().method() !== "POST") return false;
      return response.request().postDataJSON().draft === "Draft A survives a chat switch and reload";
    });
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    expect((await pagehideWrite).status()).toBe(200);
    expect((await (await fetch(new URL(`/api/chats/${chatId}`, panelUrl))).json()).draft)
      .toBe("Draft A survives a chat switch and reload");
    const staleWrite = page.waitForResponse((response) => {
      if (!new URL(response.url()).pathname.endsWith("/draft") || response.request().method() !== "POST") return false;
      return response.request().postDataJSON().draft === "Draft A old queued write";
    });
    releaseQueuedWrite();
    expect((await staleWrite).status()).toBe(409);
    await page.unroute(draftRoute);

    let releaseCreation!: () => void;
    let creationStarted!: () => void;
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const creationRequestStarted = new Promise<void>((resolve) => { creationStarted = resolve; });
    const chatsUrl = `${new URL(panelUrl).origin}/api/chats`;
    await page.route(chatsUrl, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      creationStarted();
      await creationGate;
      await route.fulfill({ response });
    });
    const creationResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/chats" && response.request().method() === "POST",
    );
    await page.locator("#newchat").click();
    await creationRequestStarted;
    try {
      expect(await page.locator("#input").isDisabled()).toBe(true);
    } finally {
      releaseCreation();
    }
    expect((await creationResponse).status()).toBe(201);
    await page.waitForFunction((previousId) => {
      const input = document.querySelector("#input") as HTMLTextAreaElement | null;
      return localStorage.getItem("isymcp.chat") !== previousId && input?.disabled === false;
    }, chatId, { timeout: 8_000 });
    const secondChatId = await page.evaluate(() => localStorage.getItem("isymcp.chat"));
    expect(secondChatId).toMatch(/^c_[0-9a-f]{16}$/);
    expect(secondChatId).not.toBe(chatId);
    await page.unroute(chatsUrl);
    await page.locator("#input").fill("B-only draft must stay with chat B");
    await page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/draft") && response.status() === 200);

    let releaseDetail!: () => void;
    let detailRequestStarted!: () => void;
    const detailGate = new Promise<void>((resolve) => { releaseDetail = resolve; });
    const detailStarted = new Promise<void>((resolve) => { detailRequestStarted = resolve; });
    const chatDetailUrl = `${new URL(panelUrl).origin}/api/chats/${chatId}`;
    await page.route(chatDetailUrl, async (route) => {
      const response = await route.fetch();
      detailRequestStarted();
      await detailGate;
      await route.fulfill({ response });
    });
    await page.locator("#chatlist button").filter({ hasText: "Seed chat A" }).click();
    await detailStarted;
    expect(await page.locator("#input").isDisabled()).toBe(true);
    expect(await page.locator("#input").inputValue()).toBe("");
    expect(await page.locator("#send").isDisabled()).toBe(true);
    expect(await page.locator("#msgs").innerText()).toContain("Escribe para empezar");
    releaseDetail();
    await waitForDisabled("#input", false);
    await waitForValue("#input", "Draft A survives a chat switch and reload");
    await page.unroute(chatDetailUrl);

    await waitForValue("#input", "Draft A survives a chat switch and reload");
    await page.waitForTimeout(450);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForValue("#input", "Draft A survives a chat switch and reload");

    expect(await page.evaluate(() => localStorage.getItem("isymcp.chat"))).toBe(chatId);
    const sessionOption = await page.locator("#tools-session option").evaluateAll((options) => {
      const option = options.find((item) => item.textContent?.includes("e2e-read-only")) as HTMLOptionElement | undefined;
      return option?.value ?? null;
    });
    expect(sessionOption).toBe(sessionFp);
    const configResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/config") && response.request().method() === "POST",
    );
    await page.locator("#tools-session").selectOption(sessionOption!);
    expect((await configResponse).status()).toBe(200);
    expect((await (await fetch(new URL(`/api/chats/${chatId}`, panelUrl))).json()).session_fp).toBe(sessionFp);
    expect(await page.locator("#tools-switch").getAttribute("aria-checked")).toBe("false");

    let releaseConfigResponse!: () => void;
    let configRequestStarted!: () => void;
    const configGate = new Promise<void>((resolve) => { releaseConfigResponse = resolve; });
    const configStarted = new Promise<void>((resolve) => { configRequestStarted = resolve; });
    const configUrl = `${new URL(panelUrl).origin}/api/chats/${chatId}/config`;
    await page.route(configUrl, async (route) => {
      const response = await route.fetch();
      configRequestStarted();
      await configGate;
      await route.fulfill({ response });
    });
    const delayedConfigResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/chats/${chatId}/config` && response.request().method() === "POST",
    );
    await page.locator("#tools-switch").click();
    await configStarted;
    expect((await (await fetch(new URL(`/api/chats/${chatId}`, panelUrl))).json()).tools_enabled).toBe(true);
    await page.locator("#chatlist button").filter({ hasText: "Nuevo chat" }).click();
    await waitForValue("#input", "B-only draft must stay with chat B");
    expect(await page.locator("#tools-switch").getAttribute("aria-checked")).toBe("false");
    releaseConfigResponse();
    expect((await delayedConfigResponse).status()).toBe(200);
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(await page.locator("#tools-switch").getAttribute("aria-checked")).toBe("false");
    await page.unroute(configUrl);

    await page.locator("#chatlist button").filter({ hasText: "Nuevo chat" }).click();
    await waitForValue("#input", "B-only draft must stay with chat B");
    expect(await page.evaluate(() => localStorage.getItem("isymcp.chat"))).toBe(secondChatId);
    await page.locator("#chatlist button").filter({ hasText: "Seed chat A" }).click();
    await waitForValue("#input", "Draft A survives a chat switch and reload");
    expect(await page.locator("#tools-switch").getAttribute("aria-checked")).toBe("true");
    const disableToolsResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/chats/${chatId}/config` && response.request().method() === "POST",
    );
    await page.locator("#tools-switch").click();
    expect((await disableToolsResponse).status()).toBe(200);
    expect(await page.locator("#tools-switch").getAttribute("aria-checked")).toBe("false");

    await page.locator("#input").fill("E2E evidence turn");
    const evidenceResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/messages") && response.request().method() === "POST",
    );
    await page.locator("#send").click();
    await page.locator("#tab-activity").click();
    await waitForText("#activity-status", "E2E synthetic fixture only; no command executed");
    expect((await evidenceResponse).status()).toBe(200);
    await waitForText("#activity-receipts", "E2E synthetic fixture only; no command executed");
    await page.locator("#tab-conversation").click();
    await snapshot("desktop-1440-conversation.png");
    await page.locator("#tab-evidence").click();
    await waitForText("#evidence-list", "test.fake_tool");
    expect(await page.locator("#evidence-list .receipt-legacy").count()).toBe(1);
    await page.locator("#evidence-filter").selectOption("completed");
    expect(await page.locator("#evidence-list .evidence-card").count()).toBe(1);
    await page.locator("#evidence-filter").selectOption("failed");
    await waitForText("#evidence-list", "No hay comprobantes que coincidan");
    await page.locator("#evidence-filter").selectOption("all");
    await page.locator("#tab-evidence").click();
    await snapshot("desktop-1440-evidence.png");
    await page.locator("#evidence-list .receipt-owner").click();
    expect(await page.locator("#tab-conversation").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#message-3").innerText()).toContain("Respuesta sintética: E2E evidence turn");

    const failedResponse = await send("FAIL E2E preserve this text");
    expect(failedResponse.status()).toBe(502);
    await waitForText("#msgs", "Synthetic bridge failure for E2E");
    await waitForValue("#input", "FAIL E2E preserve this text");
    const savedChat = await (await fetch(new URL(`/api/chats/${chatId}`, panelUrl))).json();
    expect(savedChat.tools_enabled).toBe(false);
    expect(savedChat.session_fp).toBe(sessionFp);
    expect(JSON.stringify(savedChat)).not.toContain(bridgeToken);
    expect(bridgeTurnRequests.every((body) => Object.keys(body).sort().join(",") === "chat_id,message")).toBe(true);
    expect(bridgeTurnRequests).toHaveLength(3);

    await page.locator("#tab-activity").click();
    await page.setViewportSize({ width: 900, height: 1000 });
    await assertNoHorizontalOverflow(900);
    await page.locator('[data-nav="chat"]').click();
    expect(await page.locator("#history-panel").getAttribute("aria-hidden")).toBe("false");
    await waitForFocus("#newchat");
    await snapshot("tablet-900-history.png");
    await page.keyboard.press("Escape");
    expect(await page.locator("#history-panel").getAttribute("aria-hidden")).toBe("true");
    await waitForFocus('[data-nav="chat"]');
    await page.locator('[data-nav="settings"]').click();
    await waitForFocus("#btn-verify");
    await page.locator('[data-nav="sessions"]').click();
    expect(await page.locator("#config-panel").getAttribute("aria-hidden")).toBe("false");
    await waitForFocus("#tools-session");
    await page.locator('[data-nav="settings"]').click();
    expect(await page.locator("#config-panel").getAttribute("aria-hidden")).toBe("false");
    await waitForFocus("#btn-verify");
    await page.keyboard.press("Escape");
    await waitForFocus('[data-nav="settings"]');

    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalOverflow(390);
    await page.locator('[data-nav="chat"]').click();
    expect(await page.locator("#history-panel").getAttribute("aria-hidden")).toBe("false");
    await waitForFocus("#newchat");
    await snapshot("mobile-390-history.png");
    await page.keyboard.press("Escape");
    await waitForFocus('[data-nav="chat"]');

    const blossom = await page.locator(".assistant-origin img").first().evaluate((img) => ({
      alt: (img as HTMLImageElement).alt,
      width: (img as HTMLImageElement).naturalWidth,
    }));
    expect(blossom.alt).toContain("OpenAI Blossom");
    expect(blossom.width).toBeGreaterThan(0);
    expect(browserErrors).toEqual([]);
    expect(browserRequests.every((request) => new URL(request).host === new URL(panelUrl).host)).toBe(true);
  }, 90_000);
}
