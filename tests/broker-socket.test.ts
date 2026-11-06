import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerSocketPath } from "../src/mcp/broker-socket";

test("default broker socket lives in a private XDG runtime directory", () => {
  if (process.platform === "win32") return;
  const runtime = mkdtempSync(join(tmpdir(), "isymcp-xdg-"));
  const home = mkdtempSync(join(tmpdir(), "isymcp-home-"));
  const socket = defaultBrokerSocketPath({ XDG_RUNTIME_DIR: runtime, CODEX_WEB_HTTP_HOME: home });
  expect(socket).toBe(join(runtime, "isymcp", "broker.sock"));
  expect(statSync(join(runtime, "isymcp")).mode & 0o777).toBe(0o700);
});

test("broker socket falls back to the private bridge home", () => {
  if (process.platform === "win32") return;
  const home = mkdtempSync(join(tmpdir(), "isymcp-home-"));
  const socket = defaultBrokerSocketPath({ XDG_RUNTIME_DIR: "", CODEX_WEB_HTTP_HOME: home });
  expect(socket).toBe(join(home, "run", "broker.sock"));
  expect(statSync(join(home, "run")).mode & 0o777).toBe(0o700);
});

test("broker socket tightens an existing group-writable directory", () => {
  if (process.platform === "win32") return;
  const home = mkdtempSync(join(tmpdir(), "isymcp-home-"));
  const run = join(home, "run");
  mkdirSync(run, { recursive: true });
  chmodSync(run, 0o775);
  defaultBrokerSocketPath({ XDG_RUNTIME_DIR: "", CODEX_WEB_HTTP_HOME: home });
  expect(statSync(run).mode & 0o777).toBe(0o700);
});

test("broker socket rejects a symlinked directory", () => {
  if (process.platform === "win32") return;
  const home = mkdtempSync(join(tmpdir(), "isymcp-home-"));
  const target = mkdtempSync(join(tmpdir(), "isymcp-target-"));
  symlinkSync(target, join(home, "run"));
  expect(() => defaultBrokerSocketPath({ XDG_RUNTIME_DIR: "", CODEX_WEB_HTTP_HOME: home }))
    .toThrow("broker_socket_dir_invalid");
});

test("windows uses a named pipe endpoint", () => {
  expect(defaultBrokerSocketPath({}, "win32")).toBe("\\\\.\\pipe\\isymcp-broker");
});
