import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCodexApp } from "../src/codex-app";
import { planNewConversation, writeLaunchIntent, commitConversationReceipt } from "../src/codex-conversation";
import { localAppTitle } from "../src/web-responses";

test("App profile and receipt isolate credentials, routing and workspace from native Codex", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-")), nativeHome = join(dir, "native");
  mkdirSync(nativeHome);
  writeFileSync(join(nativeHome, "auth.json"), '{"fixture":"private"}');
  writeFileSync(join(nativeHome, "config.toml"), 'model="native"\n');
  const catalogPath = join(dir, "models.json"); writeFileSync(catalogPath, '{"models":[]}');
  const intent = planNewConversation({ client: "app", cwd: dir, model: "chatgpt-web/gpt-6" }).intent;
  const options = { port: "8791", catalogPath, nativeHome, appRoot: join(dir, "apps"), executable: process.execPath };
  const app = prepareCodexApp(intent, options);
  expect(readFileSync(join(nativeHome, "config.toml"), "utf8")).toBe('model="native"\n');
  expect(app.env.CODEX_HOME).not.toBe(nativeHome);
  expect(app.env.ISYMCP_LAUNCH_ID).toBe(intent.launchId);
  const config = readFileSync(join(app.env.CODEX_HOME, "config.toml"), "utf8");
  expect(config).toContain('model_provider="isymcp_web"');
  expect(config).toContain('model="chatgpt-web/gpt-6"');
  expect(config).not.toContain("private");
  expect(config).not.toContain("openai_base_url");
  expect(statSync(join(app.env.CODEX_HOME, "auth.json")).mode & 0o777).toBe(0o600);
  expect(statSync(app.home).mode & 0o777).toBe(0o700);
  writeLaunchIntent(dir, intent);
  const receipt = commitConversationReceipt(dir, { launchId: intent.launchId, threadId: "thread-test", taskKey: "a".repeat(64),
    url: "https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", model: intent.model, effort: "high" });
  expect(receipt.client).toBe("app");
  const resume = prepareCodexApp(intent, { ...options, threadId: receipt.threadId });
  expect(resume.home).toBe(app.home);
  expect(resume.args.at(-1)).toBe("codex://threads/thread-test");
  const preferences = '\n[desktop]\nfollowUpQueueMode="queue"\n[plugins."fixture"]\nenabled=true\n';
  writeFileSync(join(app.env.CODEX_HOME, "config.toml"), config + preferences);
  const refreshed = prepareCodexApp(intent, { ...options, port: "18791", threadId: receipt.threadId });
  const updated = readFileSync(join(refreshed.env.CODEX_HOME, "config.toml"), "utf8");
  expect(updated).toContain('base_url="http://127.0.0.1:18791/v1"');
  expect(updated).toEndWith(preferences);
  expect(prepareCodexApp(intent, { ...options, port: "18791" }).home).toBe(app.home);
  writeFileSync(join(app.env.CODEX_HOME, "config.toml"), 'model="user-edit"\n');
  expect(() => prepareCodexApp(intent, options)).toThrow("web_app_profile_changed");
  expect(readFileSync(join(app.env.CODEX_HOME, "config.toml"), "utf8")).toBe('model="user-edit"\n');
});

test("App startup rejects unowned directories and overlong socket paths before copying credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-"));
  const intent = planNewConversation({ client: "app", cwd: dir }).intent;
  const nativeHome = join(dir, "native"); mkdirSync(nativeHome); writeFileSync(join(nativeHome, "auth.json"), "{}");
  const catalogPath = join(dir, "models.json"); writeFileSync(catalogPath, "{}");
  const options = { port: "8791", catalogPath, nativeHome, appRoot: dir, executable: process.execPath };
  mkdirSync(join(dir, intent.launchId));
  expect(() => prepareCodexApp(intent, options)).toThrow("web_app_profile_unowned");
  expect(() => prepareCodexApp(intent, { ...options, appRoot: join(dir, "x".repeat(110)) })).toThrow("web_app_home_too_long");
});

test("only the owned App's auxiliary title gets a local label without a conversation receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-title-"));
  const intent = planNewConversation({ client: "app", cwd: dir, model: "chatgpt-web/gpt-6" }).intent;
  writeLaunchIntent(dir, intent);
  const req = new Request("http://localhost/v1/responses", { headers: { "x-isymcp-launch-id": intent.launchId } });
  const body = { model: intent.model, input: "generate title", reasoning: { effort: "low" }, client_metadata: {
    thread_id: "auxiliary-thread", turn_id: "auxiliary-turn", "x-codex-turn-metadata": JSON.stringify({ thread_source: "thread_title", turn_trigger: "thread_title" }),
  } };
  expect(localAppTitle(req, body, dir)).toMatchObject({ output_text: "ISyMCP Web", metadata: { isymcp_source: "local_thread_title", isymcp_tools_executed: false } });
  expect(localAppTitle(req, { ...body, client_metadata: {} }, dir)).toBeNull();
  expect(localAppTitle(req, { ...body, model: "native" }, dir)).toBeNull();
  expect(localAppTitle(new Request("http://localhost"), body, dir)).toBeNull();
});
