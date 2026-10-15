import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bindNativeSource, mintNativeSession, routeNativeTool, nativeGateway } from "../src/mcp/active-native";
import { findSessionByToken, registryPath } from "../src/codex-sessions";
import { createActiveBroker } from "../src/mcp/active-broker";
import { nativeRpc } from "../src/mcp/active-native";
import { localIpcPath } from "../src/platform/ipc";

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "isymcp-native-routing-"));
  const socketPath = join(home, "broker.sock");
  const operations: any[] = [];
  let unavailable = false, busy = false;
  const server = createServer(socket => {
    let raw = "";
    socket.on("data", data => {
      raw += data;
      if (!raw.includes("\n")) return;
      const request = JSON.parse(raw); operations.push(request);
      let result: any;
      if (unavailable) return socket.end(JSON.stringify({ id: request.id, error: "owner_revoked" }));
      if (request.method === "owner_status") result = { protocolVersion: 5, acceptingExternalOwners: true };
      else if (request.method === "claim") result = { bindingId: "binding-test", activityId: request.activityId,
        environment: { cwd: home, roots: [home], writableRoots: [], sandboxPolicy: { type: "readOnly" }, tools: [{ name: "exec", freeform: true }] } };
      else if (request.method === "invoke") result = { content: [{ type: "text", text: JSON.stringify({ native_command_result: { output: "NATIVE_ONLY\n", exit_code: 0 } }) }] };
      else if (request.method === "owner_completion_fence_begin") result = busy ? null : 4;
      else if (request.method === "owner_completion_fence_commit") result = { committed: true };
      else result = { completed: true };
      socket.end(JSON.stringify({ id: request.id, result }));
    });
  });
  const endpoint = localIpcPath(socketPath);
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  if (process.platform !== "win32") chmodSync(endpoint, 0o600);
  const previous = process.env.CODEX_WEB_HTTP_HOME; process.env.CODEX_WEB_HTTP_HOME = home;
  const session = await mintNativeSession({ cwd: home, socketPath, ownerToken: "turn_private-owner-capability",
    owner: { launchId: "launch-123", threadId: "thread-123", turnId: "turn-123", epoch: "epoch-123" }, ttlMinutes: 2 });
  const refresh = () => findSessionByToken(session.token)!;
  const bind = () => bindNativeSource(session.fp, { url: "https://chatgpt.com/c/native-test", messageId: "9dcf7f6c-d1fa-415e-abba-f00f8400f421" });
  return { home, operations, session, refresh, bind, unavailable: () => { unavailable = true; }, busy: (v: boolean) => { busy = v; },
    close: async () => { if (previous === undefined) delete process.env.CODEX_WEB_HTTP_HOME; else process.env.CODEX_WEB_HTTP_HOME = previous;
      await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const payload = (out: any) => JSON.parse(out.content[0].text);

test("bootstrap waits for a real source binding while exec remains blocked", async () => {
  const f = await fixture();
  try {
    const start = routeNativeTool(f.refresh(), "codex_turn_start", {});
    expect(payload(await routeNativeTool(f.refresh(), "codex_exec", { command: ["true"] })).error).toContain("source_not_bound");
    f.bind(); expect(payload(await start)).toMatchObject({ started: true, backend: "active-codex" });
  } finally { await f.close(); }
});

test("owned IPC broker resolves only a correlated native result and refuses completion while busy", async () => {
  const home = mkdtempSync(join(tmpdir(), "isymcp-owned-broker-")), socket = join(home, "owner.sock");
  const broker = await createActiveBroker(socket);
  try {
    const environment = { cwd: home, roots: [home], writableRoots: [], sandboxPolicy: { type: "readOnly" }, tools: [{ name: "exec", freeform: true }] };
    const { token } = await nativeRpc(socket, { method: "owner_register", environment, ttlMs: 60000 });
    const binding = await nativeRpc(socket, { method: "claim", token, contract: "native", activityId: "activity_test" });
    const second = await nativeRpc(socket, { method: "claim", token, contract: "native", activityId: "activity_second" });
    await nativeRpc(socket, { method: "activity_complete", token, activityId: "activity_second" });
    await expect(nativeRpc(socket, { method: "invoke", bindingId: second.bindingId, wireName: "exec", freeform: true, input: "text('STALE');" })).rejects.toThrow();
    const next = nativeRpc(socket, { method: "owner_next", token });
    const call = nativeRpc(socket, { method: "invoke", bindingId: binding.bindingId, wireName: "exec", freeform: true, input: "text('CANARY');" });
    const received = await next;
    expect(received.requests).toHaveLength(1);
    expect(await nativeRpc(socket, { method: "owner_completion_fence_begin", token })).toBeNull();
    await expect(nativeRpc(socket, { method: "owner_complete", token, callId: "foreign", toolResult: { content: [] } })).rejects.toThrow();
    const content = [{ type: "text", text: "real native output" }];
    await nativeRpc(socket, { method: "owner_complete", token, callId: received.requests[0].callId, toolResult: { content } });
    expect(await call).toEqual({ content });
    await nativeRpc(socket, { method: "activity_complete", token, activityId: "activity_test" });
    const revision = await nativeRpc(socket, { method: "owner_completion_fence_begin", token });
    expect(await nativeRpc(socket, { method: "owner_completion_fence_commit", token, revision: revision - 1 })).toEqual({ committed: false });
    expect(await nativeRpc(socket, { method: "owner_completion_fence_commit", token, revision })).toEqual({ committed: true });
    await expect(nativeRpc(socket, { method: "claim", token, contract: "native", activityId: "activity_new" })).rejects.toThrow();
  } finally { await broker.close(); }
});

test("a prepared native token cannot execute; verified source activates owner-only routing and retry replay", async () => {
  const f = await fixture();
  try {
    const args = { command: ["printf", "%s\\n", "$(touch SHOULD_NOT_EXIST)'`bad`"] };
    expect(payload(await routeNativeTool(f.refresh(), "codex_exec", args)).error).toContain("source_not_bound");
    expect(f.operations.some(r => r.method === "invoke")).toBe(false);
    expect(() => bindNativeSource(f.session.fp, { url: "https://evil.test/c/x", messageId: "fallback-turn-0" })).toThrow();
    f.bind();
    const out = payload(await routeNativeTool(f.refresh(), "codex_exec", args));
    expect(out).toMatchObject({ backend: "active-codex", output: "NATIVE_ONLY\n", exit_code: 0 });
    const invocation = f.operations.find(r => r.method === "invoke");
    expect(invocation.input).toBe(nativeGateway(args.command, f.home));
    expect(invocation.bindingId).toBe("binding-test");
    expect(payload(await routeNativeTool(f.refresh(), "codex_tool_call", { wire_name: "exec", arguments: args }))).toMatchObject({ replayed: true });
    expect(f.operations.filter(r => r.method === "invoke")).toHaveLength(1);
    expect(existsSync(join(f.home, "SHOULD_NOT_EXIST"))).toBe(false);
    const inventory = payload(await routeNativeTool(f.refresh(), "codex_tool_inventory", {}));
    expect(inventory.tools).toContain("codex_exec"); expect(inventory.tools).not.toContain("codex_apply_patch");
    expect(JSON.stringify(inventory)).not.toContain("turn_private-owner-capability");
    expect(payload(await routeNativeTool(f.refresh(), "codex_exec", { command: ["pwd"], cwd: "../" })).error).toContain("cwd");
    expect(payload(await routeNativeTool(f.refresh(), "codex_exec", { command: ["pwd"], background: true })).error).toContain("unsupported");
    f.busy(true);
    expect(payload(await routeNativeTool(f.refresh(), "codex_turn_complete", { response: "result" })).error).toContain("pending");
    f.busy(false);
    expect(payload(await routeNativeTool(f.refresh(), "codex_turn_complete", { response: "result" })).completed).toBe(true);
    expect(payload(await routeNativeTool(f.refresh(), "codex_exec", args)).error).toContain("completed");
  } finally { await f.close(); }
});

test("explicit call_id rejects changed arguments and native expiry never becomes a sandbox session", async () => {
  const f = await fixture();
  try {
    f.bind(); const args = { wire_name: "exec", arguments: { command: ["pwd"] }, call_id: "native-call-123" };
    expect(payload(await routeNativeTool(f.refresh(), "codex_tool_call", args)).exit_code).toBe(0);
    expect(payload(await routeNativeTool(f.refresh(), "codex_tool_call", { ...args, arguments: { command: ["true"] } })).error).toContain("call_id");
    const registry = JSON.parse(readFileSync(registryPath(), "utf8")); registry.sessions[0].expiresAt = new Date(0).toISOString();
    writeFileSync(registryPath(), JSON.stringify(registry), { mode: 0o600 });
    expect(f.refresh()?.nativeOwner).toBeDefined();
    expect(payload(await routeNativeTool(f.refresh(), "codex_exec", { command: ["true"] })).error).toContain("expired");
  } finally { await f.close(); }
});

test("real MCP stdio refuses a disconnected native owner for every coding entry; media stays token-free", async () => {
  const f = await fixture(); let client: Client | undefined;
  try {
    f.bind(); f.unavailable();
    client = new Client({ name: "active-native-test", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/mcp/main.ts")],
      env: { ...process.env, CODEX_WEB_HTTP_HOME: f.home, ISYMCP_MEDIA_HOME: join(f.home, "media") } as Record<string, string>, stderr: "pipe" });
    transport.stderr?.on("data", () => {}); await client.connect(transport);
    const token = { turn_token: f.session.token };
    for (const [name, extra] of [ ["codex_turn_start", {}], ["codex_tool_inventory", {}],
      ["codex_exec", { command: ["touch", "LOCAL_FALLBACK"] }], ["codex_apply_patch", { patch: "*** Begin Patch\n*** Add File: LOCAL_FALLBACK\n+x\n*** End Patch" }],
      ["codex_write_stdin", { exec_id: "foreign", data: "" }], ["codex_view_image", { path: "LOCAL_FALLBACK" }],
      ["codex_tool_call", { wire_name: "exec", arguments: { command: ["touch", "LOCAL_FALLBACK"] } }],
      ["codex_turn_complete", { response: "done" }] ] as const) {
      const result: any = await client.callTool({ name, arguments: { ...token, ...extra } });
      expect(result.isError).toBe(true); expect(payload(result).backend).toBe("active-codex");
    }
    expect(existsSync(join(f.home, "LOCAL_FALLBACK"))).toBe(false);
    expect((await client.callTool({ name: "media_list", arguments: {} })).isError).not.toBe(true);
  } finally { await client?.close(); await f.close(); }
}, 15000);
