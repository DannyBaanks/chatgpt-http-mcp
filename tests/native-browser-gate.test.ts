import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChat } from "../src/chats";
import { handleChatApi, startPanel } from "../src/panel";

const originalHome = process.env.CODEX_WEB_HTTP_HOME;
const directories: string[] = [];
function privateHome() {
  const home = mkdtempSync(join(tmpdir(), "isymcp-native-browser-test-"));
  directories.push(home);
  return home;
}
afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
  else process.env.CODEX_WEB_HTTP_HOME = originalHome;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function cli(args: string[], home: string, port = "59999") {
  const proc = Bun.spawn([process.execPath, "run", "src/isymcp.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CODEX_WEB_HTTP_HOME: home, CODEX_WEB_HTTP_PORT: port },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

test("status reports blocked modes without creating sessions or starting services", async () => {
  const home = privateHome();
  const result = await cli(["native-browser", "status", "--json"], home);
  expect(result.code).toBe(0);
  const status = JSON.parse(result.stdout);
  expect(status.ready).toBe(false);
  expect(status.modes.codex.state).toBe("blocked");
  expect(status.modes.autonomous.state).toBe("blocked");
  expect(status.fallback).toBe("none");
  expect(readdirSync(home)).toEqual([]);
});

test("explicit native CLI selection fails before contacting the legacy bridge", async () => {
  const home = privateHome();
  let requests = 0;
  const bridge = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    requests++;
    return Response.json({ ok: true, reply: { text: "LEGACY_FALLBACK" } });
  } });
  try {
    const result = await cli(["ask", "hello", "--browser", "native"], home, String(bridge.port));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("native_browser_unavailable");
    expect(result.stdout).not.toContain("LEGACY_FALLBACK");
    expect(requests).toBe(0);
    expect(readdirSync(home)).toEqual([]);
  } finally { bridge.stop(true); }
});

test("panel native request never forwards the prompt to the legacy bridge", async () => {
  process.env.CODEX_WEB_HTTP_HOME = privateHome();
  const chat = createChat();
  let requests = 0;
  const bridge = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    requests++;
    return Response.json({ ok: true, reply: { text: "LEGACY_FALLBACK" } });
  } });
  try {
    const url = new URL(`http://127.0.0.1/api/chats/${chat.id}/messages`);
    const response = await handleChatApi(new Request(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "private prompt", browser: "native" }),
    }), url, String(bridge.port));
    expect(response.status).toBe(503);
    expect((await response.json()).error.type).toBe("native_browser_unavailable");
    expect(requests).toBe(0);
  } finally { bridge.stop(true); }
});

test("panel exposes the gate behind its existing local origin checks", async () => {
  const panel = startPanel(0, "59999");
  try {
    const url = new URL("/api/native-browser/status", panel.url);
    const response = await fetch(url);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()).ready).toBe(false);
    expect((await fetch(url, { headers: { origin: "https://example.com" } })).status).toBe(403);
  } finally { panel.stop(true); }
});
