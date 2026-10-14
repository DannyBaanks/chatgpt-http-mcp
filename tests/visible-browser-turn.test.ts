import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findActiveVisibleSession, sendVisibleWebTurn } from "../src/visible/browser-turn";

test("findActiveVisibleSession returns active session or null cleanly", async () => {
  const session = await findActiveVisibleSession();
  if (session) {
    expect(session.launchId).toMatch(/^[a-f0-9-]{36}$/);
    expect(session.socketPath).toContain("browser.sock");
    expect(session.inspected.url).toContain("chatgpt.com");
  } else {
    expect(session).toBeNull();
  }
});

test("sendVisibleWebTurn throws visible_browser_not_running when path is invalid", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "isymcp-no-browser-"));
  try {
    await expect(sendVisibleWebTurn("Hello", {}, tempDir)).rejects.toThrow("visible_browser_not_running");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
