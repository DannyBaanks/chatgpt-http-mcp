import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { mintSession } from "../src/codex-sessions";
import { findCodexWindowsCli } from "../src/platform/codex-windows-sandbox";
import { McpClient } from "./helpers/mcp-client";

const enabled = process.platform === "win32" &&
  process.env.ISYMCP_WINDOWS_NATIVE_E2E === "1" &&
  findCodexWindowsCli() !== null;

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    socket.setTimeout(3000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

if (enabled) test("Windows native MCP sandbox isolates files, patches the workspace, and blocks network", async () => {
  const root = mkdtempSync(join(tmpdir(), "isymcp-native-e2e-"));
  const workspace = join(root, "workspace");
  const bridgeHome = join(root, "bridge-home");
  const secret = join(bridgeHome, "private-sentinel.txt");
  const outsideWrite = join(root, "outside-write.txt");
  mkdirSync(workspace);
  const oldBridgeHome = process.env.CODEX_WEB_HTTP_HOME;
  process.env.CODEX_WEB_HTTP_HOME = bridgeHome;
  let client: McpClient | undefined;

  try {
    const writable = mintSession(workspace, { label: "windows-native-e2e-write", writable: true });
    const readOnly = mintSession(workspace, { label: "windows-native-e2e-read", writable: false });
    writeFileSync(secret, "PRIVATE_SENTINEL");
    client = await McpClient.start(bridgeHome, {
      CODEX_WEB_HTTP_WINDOWS_SANDBOX_BACKEND: "native",
      CODEX_WEB_HTTP_SANDBOX: "",
      CODEX_WEB_HTTP_SANDBOX_NET: "0",
    });

    const start = await client.call("codex_turn_start", { turn_token: writable.token });
    expect(start.started).toBe(true);

    const write = await client.call("codex_exec", {
      turn_token: writable.token,
      command: ["cmd.exe", "/d", "/c", "echo BASE>probe.txt"],
    });
    expect(write.executed, JSON.stringify(write)).toBe(true);
    expect(write.exit_code, JSON.stringify(write)).toBe(0);

    const patch = await client.call("codex_apply_patch", {
      turn_token: writable.token,
      patch: ["*** Begin Patch", "*** Update File: probe.txt", "@@", " BASE", "+PATCHED", "*** End Patch"].join("\n"),
    });
    expect(patch.executed, JSON.stringify(patch)).toBe(true);
    expect(patch.files).toEqual(["probe.txt"]);
    expect(readdirSync(workspace).some((name) => name.startsWith(".isymcp-codex-patch-"))).toBe(false);

    const read = await client.call("codex_exec", {
      turn_token: writable.token,
      command: ["cmd.exe", "/d", "/c", "type probe.txt"],
    });
    expect(read.exit_code, JSON.stringify(read)).toBe(0);
    expect(read.stdout).toBe("BASE\r\nPATCHED\r\n");

    const outsideRead = await client.call("codex_exec", {
      turn_token: writable.token,
      command: ["cmd.exe", "/d", "/c", `type "${secret}"`],
    });
    expect(outsideRead.exit_code, JSON.stringify(outsideRead)).not.toBe(0);
    expect(`${outsideRead.stdout}\n${outsideRead.stderr}`).not.toContain("PRIVATE_SENTINEL");

    const outsideWriteResult = await client.call("codex_exec", {
      turn_token: writable.token,
      command: ["cmd.exe", "/d", "/c", `echo ESCAPED>"${outsideWrite}"`],
    });
    expect(outsideWriteResult.exit_code, JSON.stringify(outsideWriteResult)).not.toBe(0);
    expect(existsSync(outsideWrite)).toBe(false);

    if (await tcpReachable("1.1.1.1", 443)) {
      const network = await client.call("codex_exec", {
        turn_token: writable.token,
        command: ["bun", "-e", `import { connect } from "node:net"; const socket=connect(443,"1.1.1.1"); socket.setTimeout(2000); socket.once("connect",()=>{console.log("NETWORK_CONNECTED");socket.destroy();process.exitCode=0}); socket.once("error",error=>{console.log("NETWORK_BLOCKED",error.code);process.exitCode=23}); socket.once("timeout",()=>{console.log("NETWORK_BLOCKED_TIMEOUT");socket.destroy();process.exitCode=23});`],
      });
      expect(network.exit_code, JSON.stringify(network)).toBe(23);
      expect(network.stdout).toContain("NETWORK_BLOCKED");
    }

    const readOnlyWrite = await client.call("codex_exec", {
      turn_token: readOnly.token,
      command: ["cmd.exe", "/d", "/c", "echo READ_ONLY_ESCAPE>readonly.txt"],
    });
    expect(readOnlyWrite.exit_code, JSON.stringify(readOnlyWrite)).not.toBe(0);
    expect(existsSync(join(workspace, "readonly.txt"))).toBe(false);

    const done = await client.call("codex_turn_complete", { turn_token: writable.token, response: "E2E passed" });
    expect(done.completed).toBe(true);
    expect(readFileSync(join(workspace, "probe.txt"), "utf8")).toBe("BASE\r\nPATCHED\r\n");
  } finally {
    client?.close();
    if (oldBridgeHome === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
    else process.env.CODEX_WEB_HTTP_HOME = oldBridgeHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
else {
  test.skip("Windows native MCP E2E is opt-in: set ISYMCP_WINDOWS_NATIVE_E2E=1 on a configured Windows host", () => {});
}
