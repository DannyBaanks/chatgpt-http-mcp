import { expect, test } from "bun:test";
import * as webTurn from "../src/web-turn";

class BrowserResource {
  connected = true;
  closeCount = 0;
  constructor(private readonly closeError?: Error) {}
  async close(): Promise<void> {
    this.connected = false;
    this.closeCount++;
    if (this.closeError) throw this.closeError;
  }
}

test("browser initialization failure closes its owned browser and preserves the original error", async () => {
  const browser = new BrowserResource(new Error("close also failed"));
  const failure = new Error("newContext failed");
  await expect(webTurn.initializeOwnedBrowser(browser, async () => { throw failure; })).rejects.toBe(failure);
  expect(browser.connected).toBe(false);
  expect(browser.closeCount).toBe(1);
});

test("successful initialization transfers the browser to its caller without closing it", async () => {
  const browser = new BrowserResource();
  const owned = { browser, page: "local initialized page" };
  expect(await webTurn.initializeOwnedBrowser(browser, async () => owned)).toBe(owned);
  expect(browser.connected).toBe(true);
  expect(browser.closeCount).toBe(0);
  await browser.close();
});

test("failed replacement leaves no closed session to reuse and releases the new browser", async () => {
  const owner = new webTurn.BrowserSessionOwner<{ browser: BrowserResource; key: string }>();
  const old = new BrowserResource();
  const initial = { browser: old, key: "profile-A" };
  expect(await owner.open("profile-A", async () => initial)).toBe(initial);
  expect(await owner.open("profile-A", async () => { throw new Error("must reuse live resource"); })).toBe(initial);
  const replacement = new BrowserResource();
  const failure = new Error("new page initialization failed");
  await expect(owner.open("profile-B", async () => {
    expect(owner.current).toBeUndefined();
    return webTurn.initializeOwnedBrowser(replacement, async () => { throw failure; });
  })).rejects.toBe(failure);
  expect(old.connected).toBe(false);
  expect(old.closeCount).toBe(1);
  expect(replacement.connected).toBe(false);
  expect(replacement.closeCount).toBe(1);
  expect(owner.current).toBeUndefined();
  const revived = { browser: new BrowserResource(), key: "profile-A" };
  expect(await owner.open("profile-A", async () => revived)).toBe(revived);
  expect(owner.current?.browser.connected).toBe(true);
  await owner.close();
  expect(revived.browser.connected).toBe(false);
});

test("a launcher failure after closing the previous session never retains that previous session", async () => {
  const owner = new webTurn.BrowserSessionOwner<{ browser: BrowserResource; key: string }>();
  const old = { browser: new BrowserResource(new Error("old close failed")), key: "profile-A" };
  await owner.open(old.key, async () => old);
  const failure = new Error("launch failed");
  await expect(owner.open("profile-B", async () => { throw failure; })).rejects.toBe(failure);
  expect(owner.current).toBeUndefined();
  expect(old.browser.connected).toBe(false);
  expect(old.browser.closeCount).toBe(1);
  await owner.close();
  expect(old.browser.closeCount).toBe(1);
});

test("a disconnected cached browser is invalidated and a later open creates a fresh session", async () => {
  const owner = new webTurn.BrowserSessionOwner<{ browser: BrowserResource; key: string }>(s => s.browser.connected);
  const old = { browser: new BrowserResource(), key: "profile-A" };
  await owner.open(old.key, async () => old);
  old.browser.connected = false;
  expect(owner.current).toBeUndefined();
  const fresh = { browser: new BrowserResource(), key: old.key };
  expect(await owner.open(old.key, async () => fresh)).toBe(fresh);
  expect(old.browser.closeCount).toBe(1);
  expect(owner.current).toBe(fresh);
  expect(fresh.browser.connected).toBe(true);
  await owner.close();
});

test("a closed cached page invalidates its connected browser before another open", async () => {
  type Session = { browser: BrowserResource; page: { closed: boolean }; key: string };
  const owner = new webTurn.BrowserSessionOwner<Session>(s => s.browser.connected && !s.page.closed);
  const old = { browser: new BrowserResource(), page: { closed: false }, key: "profile-A" };
  await owner.open(old.key, async () => old);
  old.page.closed = true;
  expect(owner.current).toBeUndefined();
  const fresh = { browser: new BrowserResource(), page: { closed: false }, key: old.key };
  expect(await owner.open(old.key, async () => fresh)).toBe(fresh);
  expect(old.browser.connected).toBe(false);
  expect(old.browser.closeCount).toBe(1);
  expect(owner.current?.page.closed).toBe(false);
  await owner.close();
});
