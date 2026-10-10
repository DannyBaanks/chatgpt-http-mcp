import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mintSession } from "../src/codex-sessions";
let client: Client, home: string, ws: string, rw: string, ro: string;
let previousHome: string | undefined;
const payload = (out: any) => JSON.parse(out.content.find((c: any) => c.type === "text").text);
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
const tool = (token: string, id: string, command: string[]) => call("codex_tool_call", {turn_token: token, call_id: id, wire_name: "exec", arguments: { command }});
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "isymcp-retry-home-"));
  ws = mkdtempSync(join(tmpdir(), "isymcp-retry-ws-"));
  previousHome = process.env.CODEX_WEB_HTTP_HOME;
  process.env.CODEX_WEB_HTTP_HOME = home;
  rw = mintSession(ws, { writable: true }).token;
  ro = mintSession(ws, { writable: false }).token;
  client = new Client({name: "retry-test", version: "1"});
  await client.connect(new StdioClientTransport({command: "bun", args: ["src/mcp/main.ts", "--contract", "native"], cwd: join(import.meta.dir, ".."), env: {...process.env, CODEX_WEB_HTTP_HOME: home, CODEX_WEB_HTTP_SANDBOX: "off"} as Record<string,string>, stderr: "ignore"}));
});
afterAll(async () => {
  if (client) { await call("codex_turn_complete", {turn_token: rw, response: "test cleanup"}); await client.close(); }
  if (previousHome === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
  else process.env.CODEX_WEB_HTTP_HOME = previousHome;
});
test("retry cache never replays writable-session output to a read-only session", async () => {
  const args = ["sh", "-c", "printf private-output"];
  expect(payload(await tool(rw, "session-bound-id", args)).stdout).toBe("private-output");
  const other = payload(await tool(ro, "session-bound-id", args));
  expect(other.error).toContain("fail-closed");
  expect(other.stdout).toBeUndefined();
});
test("concurrent retries execute the side effect once", async () => {
  const command = ["sh", "-c", "sleep 0.15; printf x >> once.txt"];
  const results = await Promise.all([tool(rw, "concurrent-retry-id", command), tool(rw, "concurrent-retry-id", command)]);
  expect(readFileSync(join(ws, "once.txt"), "utf8")).toBe("x");
  expect(results.map(payload).filter(r => r.replayed === true)).toHaveLength(1);
});
test("a call id with changed arguments is rejected without executing", async () => {
  await tool(rw, "collision-retry-id", ["sh", "-c", "printf first"]);
  const changed = payload(await tool(rw, "collision-retry-id", ["sh", "-c", "printf x > collision.txt"]));
  expect(changed.error).toContain("call_id");
  expect(existsSync(join(ws, "collision.txt"))).toBe(false);
});
test("image retry preserves the original image content", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=", "base64");
  writeFileSync(join(ws, "image.png"), bytes);
  const args = {turn_token: rw, call_id: "image-retry-id", wire_name: "view_image", arguments: {path: "image.png"}};
  const first: any = await call("codex_tool_call", args), second: any = await call("codex_tool_call", args);
  expect(first.content.find((c: any) => c.type === "image").data).toBe(bytes.toString("base64"));
  expect(second.content.find((c: any) => c.type === "image")).toEqual(first.content.find((c: any) => c.type === "image"));
  expect(payload(second).replayed).toBe(true);
});
test("polling an exited background command returns final output and then an empty delta", async () => {
  const bg = payload(await call("codex_exec", {turn_token: rw, command: ["sh", "-c", "sleep 0.1; printf final-output"], background: true, capture_ms: 0}));
  await Bun.sleep(300);
  const args = {turn_token: rw, exec_id: bg.exec_id, data: "", wait_ms: 0};
  const final = payload(await call("codex_write_stdin", args));
  expect(final.stdout).toBe("final-output");
  expect(final.alive).toBe(false);
  expect(final.exit_code).toBe(0);
  expect(payload(await call("codex_write_stdin", args)).stdout).toBe("");
  expect(payload(await call("codex_write_stdin", {...args, data: "x"})).error).toContain("termino");
});
