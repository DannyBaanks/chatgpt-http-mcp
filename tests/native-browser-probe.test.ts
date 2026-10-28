import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredClientMethods, parseBrowserOption, probeNativeBrowser, rejectUnavailableBrowser } from "../src/visible/native-browser";
import { createHandler } from "../src/server";
import { loadConfig } from "../src/config";
import { bridgeAuthHeaders } from "../src/local-guard";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("native selection accepts both CLI spellings and rejects ambiguous options", () => {
  expect(parseBrowserOption(["hello", "--browser=native", "--new"]))
    .toEqual({ args: ["hello", "--new"], browser: "native" });
  expect(parseBrowserOption(["--browser", "native", "hello"]))
    .toEqual({ args: ["hello"], browser: "native" });
  expect(() => parseBrowserOption(["--browser", "--new"])).toThrow("browser_selection_missing");
  expect(() => parseBrowserOption(["--browser=native", "--browser", "native"]))
    .toThrow("browser_selection_duplicate");
});

test("unknown browser selection cannot downgrade to the legacy path", async () => {
  expect(rejectUnavailableBrowser(undefined)).toBeNull();
  for (const value of ["chrome", "nativ", "", null, {}, true]) {
    const denied = rejectUnavailableBrowser(value)!;
    expect(denied.status).toBe(400);
    expect((await denied.json()).error.type).toBe("browser_selection_invalid");
  }
});

const schema = {
  oneOf: ["initialize", "thread/start", "turn/start", "browser/open"].map(method => ({
    properties: { method: { enum: [method] } },
  })),
};

test("schema inspection rejects malformed or irrelevant declarations", () => {
  for (const input of [null, [], {}, { method: "browser/open" }, { properties: { method: { enum: [7] } } }])
    expect(() => declaredClientMethods(input)).toThrow("native_browser_schema_invalid");
  expect(declaredClientMethods(schema)).toEqual(["browser/open", "initialize", "thread/start", "turn/start"]);
});

test("even a protocol declaring browser methods never enables an unverified adapter", async () => {
  if (process.platform === "win32") return; // Unix executable fixture; parser and gate are cross-platform.
  const directory = mkdtempSync(join(tmpdir(), "isymcp-probe-fixture-"));
  directories.push(directory);
  const binary = join(directory, "codex-fixture");
  writeFileSync(binary, `#!/usr/bin/env bun
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
if(args[0]==='--version') console.log('codex-cli 0.162.0');
else if(JSON.stringify(args.slice(0,4))===JSON.stringify(['app-server','generate-json-schema','--experimental','--out']) && args.length===5)
 writeFileSync(join(args[4],'ClientRequest.json'),${JSON.stringify(JSON.stringify(schema))});
else process.exit(99);
`);
  chmodSync(binary, 0o700);
  const report = await probeNativeBrowser(binary);
  expect(report.ready).toBe(false);
  expect(report.modes.codex.state).toBe("blocked");
  expect(report.modes.autonomous.state).toBe("blocked");
  expect(report.protocol).toMatchObject({ version: "codex-cli 0.162.0", methodCount: 4, browserMethodCandidates: ["browser/open"] });
});

test("missing runtime reports probe failure rather than a successful empty protocol", async () => {
  const report = await probeNativeBrowser("/nonexistent/isymcp-native-browser-codex");
  expect(report.protocol).toEqual({ error: "native_browser_probe_version_failed" });
  expect(report.ready).toBe(false);
});

test("direct bridge requests reject native selection before running a chat turn", async () => {
  const handler = createHandler(loadConfig({ ...process.env, CODEX_WEB_HTTP_PORT: "0" }));
  const response = await handler(new Request("http://127.0.0.1/isymcp/chat/turn", {
    method: "POST", headers: bridgeAuthHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ chat_id: "not-a-real-chat", message: "must not execute", browser: "native" }),
  }));
  expect(response.status).toBe(503);
  expect((await response.json()).error.type).toBe("native_browser_unavailable");
});
