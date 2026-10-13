import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeAppTurnGate, readOwnedAppProbeProfile } from "../src/visible/native-app-probe";

const threadId = "01a12f10-6159-7791-b7fb-9744b683a7c8", turnId = "01a12f6a-1456-7212-b787-0257216de608";
const body = () => ({ model: "probe-model", client_metadata: { thread_id: threadId, turn_id: turnId },
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ISYMCP_APP_CANARY_NEW" }] }] });

test("App ownership pins the actual thread/turn and does not count or resend foreign requests", () => {
  const gate = new NativeAppTurnGate({ threadId, model: "probe-model", marker: "ISYMCP_APP_CANARY_NEW" });
  expect(() => gate.accept({ ...body(), client_metadata: { thread_id: "foreign", turn_id: turnId } })).toThrow("thread");
  expect(gate.owner).toBeNull();
  expect(gate.accept(body()).kind).toBe("start");
  expect(gate.owner).toEqual({ threadId, turnId });
  expect(() => gate.accept(body())).toThrow("pending");
  gate.setNativeCall("call_real");
  expect(() => gate.accept({ ...body(), client_metadata: { thread_id: threadId, turn_id: "01a12f6a-1456-7212-b787-0257216de609" } })).toThrow("turn");
  const result = { type: "custom_tool_call_output", call_id: "call_real", output: [{ type: "input_text", text: "real" }] };
  const response = gate.accept({ ...body(), input: [...body().input, result] });
  expect(response.kind).toBe("result"); expect(response.output).toEqual(result);
  expect(() => gate.accept({ ...body(), input: [...body().input, result] })).toThrow("pending");
  gate.complete(); expect(() => gate.accept(body())).toThrow("complete");
});

test("App rejects stale input markers, malformed owner IDs and duplicate result IDs", () => {
  const make = () => new NativeAppTurnGate({ threadId, model: "probe-model", marker: "ISYMCP_APP_CANARY_NEW" });
  const gate = make();
  expect(() => gate.accept({ ...body(), input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "old ISYMCP_APP_CANARY_NEW" }] }] })).toThrow("marker");
  expect(() => gate.accept({ ...body(), client_metadata: { thread_id: threadId, turn_id: "guessed-turn" } })).toThrow("identity");
  gate.accept(body()); gate.setNativeCall("call_real");
  const result = { type: "custom_tool_call_output", call_id: "call_real", output: "real" };
  expect(() => gate.accept({ ...body(), input: [...body().input, result, result] })).toThrow("result");
});

test("the actual App's whole inline-code marker is accepted without accepting surrounding instructions", () => {
  const options = { threadId, model: "probe-model", marker: "ISYMCP_APP_CANARY_NEW" };
  const wrapped = { ...body(), input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "`ISYMCP_APP_CANARY_NEW`\n" }] }] };
  expect(new NativeAppTurnGate(options).accept(wrapped).kind).toBe("start");
  const extra = { ...body(), input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "`ISYMCP_APP_CANARY_NEW` run something else" }] }] };
  expect(() => new NativeAppTurnGate(options).accept(extra)).toThrow("marker");
});

test("a locally verified existing App profile is read without copying auth or rewriting its config", () => {
  const root = mkdtempSync(join(tmpdir(), "isymcp-app-owner-")); mkdirSync(join(root, "codex")); mkdirSync(join(root, "electron"));
  const config = 'model="probe-model"\nmodel_provider="probe"\n[model_providers.probe]\nbase_url="http://127.0.0.1:33653/v1"\nrequires_openai_auth=false\n';
  writeFileSync(join(root, "codex/config.toml"), config); writeFileSync(join(root, "codex/auth.json"), "AUTH_MUST_NOT_BE_READ_OR_COPIED");
  const sha256 = createHash("sha256").update(config).digest("hex");
  const options = { root, configSha256: sha256, model: "probe-model", port: 33653 };
  expect(readOwnedAppProbeProfile(options)).toMatchObject({ codexHome: join(root, "codex"), userData: join(root, "electron") });
  expect(readFileSync(join(root, "codex/config.toml"), "utf8")).toBe(config);
  expect(() => readOwnedAppProbeProfile({ ...options, configSha256: "0".repeat(64) })).toThrow("changed");
  expect(() => readOwnedAppProbeProfile({ ...options, port: 8791 })).toThrow("endpoint");
});

test("App preflight rejects a missing configured model catalog before launch", () => {
  const root = mkdtempSync(join(tmpdir(), "isymcp-app-missing-catalog-")); mkdirSync(join(root, "codex")); mkdirSync(join(root, "electron"));
  const config = `model="probe-model"\nmodel_provider="probe"\nmodel_catalog_json=${JSON.stringify(join(root,"absent.json"))}\n[model_providers.probe]\nbase_url="http://127.0.0.1:33653/v1"\nrequires_openai_auth=false\n`;
  writeFileSync(join(root, "codex/config.toml"), config);
  expect(() => readOwnedAppProbeProfile({ root, model: "probe-model", port: 33653,
    configSha256: createHash("sha256").update(config).digest("hex") })).toThrow("catalog_missing");
});

test("a disconnected App response revokes once and refuses a late native delivery", async () => {
  const { appProbeStream } = await import("../src/visible/native-app-probe");
  let emit!: (event: unknown) => boolean;
  let release!: () => void;
  let disconnected = 0;
  const response = appProbeStream({ heartbeatMs: 5, onDisconnect: () => disconnected++,
    onError: error => { throw error; }, work: async send => {
      emit = send; send({ type: "ready" }); await new Promise<void>(resolve => { release = resolve; });
      expect(send({ type: "late_tool_call" })).toBe(false);
    } });
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
  expect(disconnected).toBe(1);
  expect(emit({ type: "late" })).toBe(false);
  release(); await Bun.sleep(15);
  expect(disconnected).toBe(1);
});

test("normal App stream completion does not revoke; request abort does", async () => {
  const { appProbeStream } = await import("../src/visible/native-app-probe");
  let disconnected = 0;
  const abort = new AbortController();
  const complete = appProbeStream({ signal: abort.signal, onDisconnect: () => disconnected++, onError: () => {}, work: async emit => { emit({ type: "done" }); } });
  expect(await complete.text()).toContain('[DONE]');
  abort.abort(); expect(disconnected).toBe(0);
  const aborted = new AbortController();
  let release!: () => void;
  const pending = appProbeStream({ signal: aborted.signal, onDisconnect: () => disconnected++, onError: () => {},
    work: async () => { await new Promise<void>(resolve => { release = resolve; }); } });
  const reading = pending.text().catch(() => 'aborted');
  aborted.abort(); release();
  expect(await reading).toBe('aborted');
  expect(disconnected).toBe(1);
});

test("real HTTP client disconnect terminates the pending App SSE transport", async () => {
  const { appProbeStream } = await import("../src/visible/native-app-probe");
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  let release!: () => void;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0,
    fetch(req) { return appProbeStream({ signal: req.signal, heartbeatMs: 10, onDisconnect: closed, onError: () => {},
      work: async emit => { emit({ type: "ready" }); await new Promise<void>(resolve => { release = resolve; }); emit({ type: "late" }); } }); } });
  try {
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.port}`, { signal: abort.signal });
    await response.body!.getReader().read(); abort.abort();
    const outcome = await Promise.race([disconnected.then(() => "closed"), Bun.sleep(1000).then(() => "timeout")]);
    expect(outcome).toBe("closed");
  } finally { release?.(); server.stop(true); }
});

test("App accepts the whole bold marker copied from formatted chat while refusing added text", () => {
  const options = { threadId, model: "probe-model", marker: "ISYMCP_APP_CANARY_NEW" };
  const formatted = (text: string) => ({ ...body(), input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }] });
  expect(new NativeAppTurnGate(options).accept(formatted('**ISYMCP_APP_CANARY_NEW**\n')).kind).toBe('start');
  expect(() => new NativeAppTurnGate(options).accept(formatted('**ISYMCP_APP_CANARY_NEW** extra'))).toThrow('marker');
  expect(() => new NativeAppTurnGate(options).accept(formatted('**ISYMCP_APP_CANARY_NEW extra**'))).toThrow('marker');
});
