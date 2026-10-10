import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mintSession } from "../src/codex-sessions";

let client: Client, home: string, ws: string, token: string;
let previousHome: string | undefined;
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const text = (result: any) => JSON.parse(result.content.find((c: any) => c.type === "text").text);
const start = (turnToken = token) => client.callTool({name: "codex_turn_start", arguments: {turn_token: turnToken}});
function bindRequest(filename: string, sha256: string) {
  const path = join(home, "codex-sessions.json"), registry = JSON.parse(readFileSync(path, "utf8"));
  registry.sessions.find((session: any) => session.token === token).request = {filename, sha256};
  writeFileSync(path, JSON.stringify(registry), {mode: 0o600});
}
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "isymcp-bootstrap-home-"));
  ws = mkdtempSync(join(tmpdir(), "isymcp-bootstrap-ws-"));
  previousHome = process.env.CODEX_WEB_HTTP_HOME;
  process.env.CODEX_WEB_HTTP_HOME = home;
  token = mintSession(ws, {writable: true}).token;
  client = new Client({name: "bootstrap-test", version: "1"});
  await client.connect(new StdioClientTransport({command: "bun", args: [join(import.meta.dir, "../src/mcp/main.ts"), "--contract", "native"], env: {...process.env, CODEX_WEB_HTTP_HOME: home} as Record<string, string>, stderr: "ignore"}));
});
afterAll(async () => {
  await client?.close();
  if (previousHome === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
  else process.env.CODEX_WEB_HTTP_HOME = previousHome;
});

test("a real session loads the fixed local guide with matching SHA and no outer Codex response contract", async () => {
  const result = text(await start());
  expect(result.started).toBe(true);
  expect(result.bootstrap.version).toBe("1");
  const source = readFileSync(join(import.meta.dir, "../src/mcp/SKILL.md"), "utf8");
  expect(result.bootstrap.content).toBe(source);
  expect(result.bootstrap.sha256).toBe(digest(source));
  expect(result.bootstrap.content.length).toBeGreaterThan(1500);
  expect(result.bootstrap.content).not.toContain("ISyMCP CODEX RESPONSE CONTRACT");
  expect(result.request).toBeUndefined();
});

test("an unknown token remains a stub without guide or local request", async () => {
  const result = text(await start("unknown-token-at-least-twenty-characters"));
  expect(result.bootstrap).toBeUndefined();
  expect(result.request).toBeUndefined();
  expect(result.session).toBeUndefined();
});

test("a locally bound request is returned verbatim with its verified hash", async () => {
  const content = "Explicit user task: inspect the workspace and report the result.\n";
  writeFileSync(join(ws, "REQUEST.md"), content);
  bindRequest("REQUEST.md", digest(content));
  const result = text(await start());
  expect(result.started).toBe(true);
  expect(result.request).toMatchObject({filename: "REQUEST.md", sha256: digest(content), content});
});

test("a changed bound request fails explicitly without claiming that the turn started", async () => {
  writeFileSync(join(ws, "REQUEST.md"), "different task\n");
  const result = await start();
  expect(result.isError).toBe(true);
  const payload = text(result);
  expect(typeof payload.error).toBe("string");
  expect(payload.started).not.toBe(true);
  expect(payload.request).toBeUndefined();
});
