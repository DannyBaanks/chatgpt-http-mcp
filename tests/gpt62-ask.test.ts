import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseCapabilities } from "../src/config";
import { availableRoutes, resolveLimits } from "../src/web-models";
import { assertWebSelection, webModelLabel } from "../src/responses/selection";
import { canaryChatId } from "../src/canary";
import { createChat, loadChat } from "../src/chats";
import { runChatTurn } from "../src/chat-turn";

const home = mkdtempSync(join(tmpdir(), "isymcp-gpt62-"));
const previous = process.env.CODEX_WEB_HTTP_HOME;
process.env.CODEX_WEB_HTTP_HOME = home;
afterAll(() => { if (previous === undefined) delete process.env.CODEX_WEB_HTTP_HOME; else process.env.CODEX_WEB_HTTP_HOME = previous; });

test("GPT-6.2 uses an exact alias and never accepts GPT-6 as a substitute", () => {
  expect(webModelLabel("chatgpt-web/gpt-6.2")).toBe("GPT-6.2");
  const seen = { model: "GPT-6.2", effort: "6.2 High", pill: "6.2 High", effortPosition: 3, effortSteps: 3 };
  expect(() => assertWebSelection("chatgpt-web/gpt-6.2", "high", seen)).not.toThrow();
  expect(() => assertWebSelection("chatgpt-web/gpt-6.2", "high", { ...seen, model: "GPT-6" })).toThrow("web_model_state_mismatch");
});

test("6.2 catalog requires its own capability and keeps a conservative transport budget", () => {
  expect(availableRoutes(parseCapabilities("gpt62")).map(r => r.slug)).toEqual(["chatgpt-web/gpt-6.2"]);
  expect(availableRoutes(parseCapabilities("sol,gpt6")).some(r => r.slug === "chatgpt-web/gpt-6.2")).toBe(false);
  expect(resolveLimits("gpt-6.2", "high", parseCapabilities("gpt62,pro,bigger")).contextWindow).toBe(32_000);
});

test("local ask installs model preflight before sending and retains its failure detail", async () => {
  let preflight = false;
  const chat = createChat("ask-preflight");
  const result = await runChatTurn(chat.id, "hello", loadConfig({}), { send: async (_prompt, options) => {
    preflight = typeof options.beforeSubmit === "function";
    throw Error("web_model_unavailable: exact choice is absent for GPT-6.2");
  } });
  expect(preflight).toBe(true);
  expect(result.ok).toBe(false);
  expect(result.reply.meta?.detail).toContain("web_model_unavailable");
});


test("6.2 canary has its own persistent thread and preserves the legacy canary", () => {
  const legacy = createChat("[canary] ISyMCP");
  const current = canaryChatId();
  expect(current).not.toBe(legacy.id);
  expect(canaryChatId()).toBe(current);
  expect(loadChat(legacy.id)?.title).toBe("[canary] ISyMCP");
});
