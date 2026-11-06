import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActiveBroker } from "../src/mcp/active-broker";
import { bindNativeSource, mintNativeSession, nativeGateway, nativeRpc, routeNativeTool } from "../src/mcp/active-native";
import { findSessionByToken, registryPath } from "../src/codex-sessions";
import { publishCanaryResult } from "../src/mcp/current-owner-canary";

const marker = "ISYMCP_NATIVE_0123456789abcdef0123456789abcdef";
// Independently specified canary argv; the caller cannot supply shell code.
const command = ["sh", "-c", `echo ${marker}; echo ISYMCP_NATIVE_CALL_ID:$CODEX_TOOL_CALL_ID`];
const originalHome = process.env.CODEX_WEB_HTTP_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
  else process.env.CODEX_WEB_HTTP_HOME = originalHome;
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "isymcp-owner-canary-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
  const socket = join(home, "owner.sock");
  const broker = await createActiveBroker(socket);
  const environment = { cwd: home, roots: [home], writableRoots: [],
    sandboxPolicy: { type: "dangerFullAccess" },
    executionGrant: { kind: "current-turn-canary", marker },
    tools: [{ name: "exec", freeform: true }] };
  return { home, socket, environment, close: async () => { await broker.close(); rmSync(home, { force: true, recursive: true }); } };
}
const payload = (result: any) => JSON.parse(result.content[0].text);

test("native result publication is private from first visibility and cannot replace a receipt", () => {
  const home = mkdtempSync(join(tmpdir(), "isymcp-canary-result-"));
  try {
    const result = { output: marker + "\nISYMCP_NATIVE_CALL_ID:exec-unit-test\n", exit_code: 0 };
    publishCanaryResult(home, result);
    const file = join(home, "native-result.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(result);
    expect(() => publishCanaryResult(home, { output: "CHANGED", exit_code: 1 })).toThrow();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(result);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("canary registration reports the actual full-access host but grants only fixed read output", async () => {
  const f = await fixture();
  try {
    const { token } = await nativeRpc(f.socket, { method: "owner_register", environment: f.environment, ttlMs: 60000 });
    const session = await mintNativeSession({ cwd: f.home, socketPath: f.socket, ownerToken: token,
      owner: { launchId: "launch-123", threadId: "thread-123", turnId: "turn-123", epoch: "epoch-123" }, ttlMinutes: 1,
      canary: { marker, hostSandbox: "dangerFullAccess" } });
    bindNativeSource(session.fp, { url: "https://chatgpt.com/c/canary-test", messageId: "9dcf7f6c-d1fa-415e-abba-f00f8400f421" });
    const inventory = payload(await routeNativeTool(findSessionByToken(session.token)!, "codex_tool_inventory", {}));
    expect(inventory.limits).toMatchObject({ canary_only: true, host_sandbox: "dangerFullAccess", background: false, patch: false });
    expect(inventory.limits.allowed_command).toEqual(command);
    expect(inventory.limits.read_only).not.toBe(true); // No claim of an OS read-only sandbox.
    const rejected = payload(await routeNativeTool(findSessionByToken(session.token)!, "codex_exec", { command: ["touch", "MUST_NOT_RUN"] }));
    expect(rejected.error).toBe("native_canary_command_required");
  } finally { await f.close(); }
});

test("broker itself rejects arbitrary gateway input under a canary grant", async () => {
  const f = await fixture();
  try {
    const { token } = await nativeRpc(f.socket, { method: "owner_register", environment: f.environment, ttlMs: 60000 });
    const binding = await nativeRpc(f.socket, { method: "claim", token, activityId: "activity_canary", contract: "native" });
    await expect(nativeRpc(f.socket, { method: "invoke", bindingId: binding.bindingId,
      wireName: "exec", freeform: true, input: nativeGateway(["touch", "MUST_NOT_RUN"], f.home) })).rejects.toThrow();
    const waiting = nativeRpc(f.socket, { method: "invoke", bindingId: binding.bindingId,
      wireName: "exec", freeform: true, input: nativeGateway(command, f.home) });
    const delivery = await nativeRpc(f.socket, { method: "owner_next", token });
    expect(delivery.requests).toHaveLength(1);
    await nativeRpc(f.socket, { method: "owner_complete", token, callId: delivery.requests[0].callId,
      toolResult: { content: [{ type: "text", text: "unit-test-result-not-live-evidence" }] } });
    await waiting;
  } finally { await f.close(); }
});

test("full access without a valid canary grant remains forbidden", async () => {
  const f = await fixture();
  try {
    for (const grant of [undefined, { kind: "current-turn-canary", marker: "$(touch BAD)" }, { kind: "arbitrary", marker }]) {
      await expect(nativeRpc(f.socket, { method: "owner_register", ttlMs: 60000,
        environment: { ...f.environment, executionGrant: grant } })).rejects.toThrow();
    }
  } finally { await f.close(); }
});

test("a rejected owner claim revokes the session it just minted", async () => {
  const f = await fixture();
  try {
    const { token } = await nativeRpc(f.socket, { method: "owner_register", environment: f.environment, ttlMs: 60000 });
    await expect(mintNativeSession({ cwd: f.home, socketPath: f.socket, ownerToken: token,
      owner: { launchId: "launch-123", threadId: "thread-123", turnId: "turn-123", epoch: "epoch-123" }, ttlMinutes: 1,
      canary: { marker: "ISYMCP_NATIVE_ffffffffffffffffffffffffffffffff", hostSandbox: "dangerFullAccess" },
    })).rejects.toThrow("native_canary_environment_mismatch");
    expect(JSON.parse(readFileSync(registryPath(), "utf8")).sessions).toEqual([]);
  } finally { await f.close(); }
});

test("canary owner registration canonicalizes its workspace before gateway validation", async () => {
  const f = await fixture();
  try {
    const { token } = await nativeRpc(f.socket, { method: "owner_register", ttlMs: 60000,
      environment: { ...f.environment, cwd: f.home + "/" } });
    const binding = await nativeRpc(f.socket, { method: "claim", token, contract: "native", activityId: "activity_canonical" });
    expect(binding.environment.cwd).toBe(f.home);
    const waiting = nativeRpc(f.socket, { method: "invoke", bindingId: binding.bindingId,
      wireName: "exec", freeform: true, input: nativeGateway(command, f.home) });
    const delivery = await nativeRpc(f.socket, { method: "owner_next", token });
    await nativeRpc(f.socket, { method: "owner_complete", token, callId: delivery.requests[0].callId,
      toolResult: { content: [{ type: "text", text: "unit-only" }] } });
    await waiting;
  } finally { await f.close(); }
});
