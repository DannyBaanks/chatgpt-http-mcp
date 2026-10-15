import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCodexApp } from "../src/codex-app";
import { localAppTitle } from "../src/web-responses";

test("synthetic App launcher is disabled before touching authentication or profile files", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-disabled-"));
  const nativeHome = join(dir, "native");
  mkdirSync(nativeHome);
  const auth = join(nativeHome, "auth.json");
  writeFileSync(auth, '{"fixture":"private"}');
  const intent = {
    version: "isymcp-launch-intent/1",
    launchId: "11111111-1111-4111-8111-111111111111",
    client: "app",
    cwd: dir,
    model: "chatgpt-web/gpt-6",
    effort: "high",
  };

  expect(() => prepareCodexApp(intent, { nativeHome, appRoot: join(dir, "apps") })).toThrow("UNKNOWN / NO EXECUTE");
  expect(existsSync(join(dir, "apps"))).toBe(false);
  expect(readFileSync(auth, "utf8")).toBe('{"fixture":"private"}');
});

test("legacy App title metadata gets a local label without starting a private profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-title-"));
  const launchId = "22222222-2222-4222-8222-222222222222";
  const model = "chatgpt-web/gpt-6";
  writeFileSync(join(dir, `intent-${launchId}.json`), JSON.stringify({
    version: "isymcp-launch-intent/1", launchId, client: "app", cwd: dir, model, effort: "high",
  }));
  const req = new Request("http://localhost/v1/responses", { headers: { "x-isymcp-launch-id": launchId } });
  const body = { model, input: "generate title", reasoning: { effort: "low" }, client_metadata: {
    thread_id: "auxiliary-thread", turn_id: "auxiliary-turn", "x-codex-turn-metadata": JSON.stringify({ thread_source: "thread_title", turn_trigger: "thread_title" }),
  } };
  expect(localAppTitle(req, body, dir)).toMatchObject({ output_text: "ISyMCP Web", metadata: { isymcp_source: "local_thread_title", isymcp_tools_executed: false } });
  expect(localAppTitle(req, { ...body, client_metadata: {} }, dir)).toBeNull();
  expect(localAppTitle(req, { ...body, model: "native" }, dir)).toBeNull();
  expect(localAppTitle(new Request("http://localhost"), body, dir)).toBeNull();
});
