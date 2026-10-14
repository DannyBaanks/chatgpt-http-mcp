#!/usr/bin/env bun
// Scoped CLI ownership canary. Chrome uses OUR connector; only installed Codex
// executes its canary. This controller is a probe, not a general Web provider.
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildResponseBody, responseEvents } from "../src/web-responses";
import { correlateNativeToolResult } from "../src/visible/host";
import { findSessionByToken, revokeSession, type CodexSession } from "../src/codex-sessions";
import { mintNativeSession, nativeGateway, nativeRpc } from "../src/mcp/active-native";
import { createActiveBroker } from "../src/mcp/active-broker";

function option(name: string, fallback?: string) {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Bun.argv[index + 1]; if (!value || value.startsWith("--")) throw Error("missing_option:" + name);
  return value;
}
const evidence = option("--evidence-dir");
if (!evidence) throw Error("usage: bun scripts/probe-active-isymcp.ts --evidence-dir <NEW_PRIVATE_DIR> [--wait-seconds 1200]");
const dir = resolve(evidence), waitMs = Number(option("--wait-seconds", "1200")) * 1000;
if (!Number.isSafeInteger(waitMs) || waitMs < 60000 || waitMs > 1200000) throw Error("invalid_probe_wait");
mkdirSync(dir, { mode: 0o700 });
const socketPath = join(dir, "owner.sock");
const broker = await createActiveBroker(socketPath);
const cwd = join(dir, "workspace"), codexHome = join(dir, "codex-home");
mkdirSync(cwd, { mode: 0o700 }); mkdirSync(codexHome, { mode: 0o700 });
const runId = randomUUID(), nonce = "ISYMCP_ACTIVE_NATIVE_" + randomUUID().replaceAll("-", "");
const command = ["printf", "%s\n", nonce];
const model = "gpt-6.1-sol";
const catalog = await Bun.file(join(process.env.HOME!, ".codex/models_cache.json")).json();
const row = catalog.models?.find((m: any) => m.slug === model); if (!row) throw Error("native_model_catalog_entry_missing");
const { model_messages: _private, availability_nux: _notice, ...safeRow } = row;
const save = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
save("model-catalog.json", { models: [{ ...safeRow, base_instructions: "Execute only the authorized native canary; this is a transport probe.", supported_in_api: true, tool_mode: "code_mode_only" }] });
const startedAt = new Date().toISOString();
let phase = "starting", requests = 0, failure: string | undefined, threadId = "", turnId = "", nativeCall: any, nativeOutput: any;
let ownerToken: string | undefined, session: CodexSession | undefined;
const status = () => save("status.json", { controllerPid: process.pid, startedAt, updatedAt: new Date().toISOString(), phase, threadId, turnId, requests, nonce, fingerprint: session?.fp, failure });
let finish: (value: any) => void = () => {};
const finished = new Promise<any>(resolve => { finish = resolve; });
const encoder = new TextEncoder();
function waitingResponse(work: (emit: (event: any) => void, response: any) => Promise<void>) {
  return new Response(new ReadableStream({ async start(controller) {
    const response = buildResponseBody(model, "", "");
    const emit = (event: any) => controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    const initial = { ...response, status: "in_progress", output: [] };
    emit({ type: "response.created", response: initial, sequence_number: 0 });
    emit({ type: "response.in_progress", response: initial, sequence_number: 1 });
    const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": waiting for ISyMCP\n\n")), 15000);
    try { await work(emit, response); controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); }
    catch (e) { failure = String(e); phase = "failed"; status(); controller.error(e); finish({ failed: true }); }
    finally { clearInterval(heartbeat); }
  } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
  if (new URL(req.url).pathname !== "/v1/responses" || req.method !== "POST") return new Response("not found", { status: 404 });
  if (req.headers.get("authorization") !== "Bearer " + runId) return new Response("foreign request", { status: 403 });
  requests++; status(); const body: any = await req.json();
  if (requests === 1) return waitingResponse(async (emit, response) => {
    const deadline = Date.now() + 15000;
    while (!threadId || !turnId) { if (Date.now() > deadline) throw Error("native_owner_identity_not_observed"); await Bun.sleep(10); }
    if (req.headers.get("thread-id") !== threadId) throw Error("native_request_thread_mismatch");
    const registration = await nativeRpc(socketPath, { method: "owner_register", environment: {
      cwd, roots: [cwd], writableRoots: [], sandboxPolicy: { type: "readOnly" },
      tools: [{ name: "exec", description: "Run JavaScript to orchestrate native commands", parameters: {}, freeform: true }],
    }, ttlMs: waitMs, traceId: "active_" + runId.replaceAll("-", "") });
    ownerToken = registration.token;
    if (typeof ownerToken !== "string") throw Error("native_owner_token_missing");
    session = await mintNativeSession({ cwd, socketPath, ownerToken, owner: { launchId: runId, threadId, turnId, epoch: randomUUID() }, ttlMinutes: waitMs / 60000 });
    save("grant.json", { turn_token: session.token, fingerprint: session.fp, command, cwd });
    writeFileSync(join(dir, "compose.txt"), [
      "COMANDO: @CODEX ISYMCP. Usa explícitamente Codex ISyMCP, sin herramientas alternativas.",
      "turn_token: " + session.token,
      "Llama codex_turn_start y lee bootstrap.content; consulta codex_tool_inventory.",
      "Ejecuta una sola vez codex_exec con command=" + JSON.stringify(command) + ".",
      "Devuelve output y exit_code reales; confirma backend y dueño; cierra con codex_turn_complete.",
    ].join("\n"), { mode: 0o600, flag: "wx" });
    phase = "waiting_for_bound_chrome"; status();
    save("ready.json", { threadId, turnId, fingerprint: session.fp, nonce, compose: join(dir, "compose.txt"), expiresAt: session.expiresAt });
    console.log(JSON.stringify({ ready: true, threadId, turnId, fingerprint: session.fp, compose: join(dir, "compose.txt") }));
    const next = await nativeRpc(socketPath, { method: "owner_next", token: ownerToken }, waitMs);
    if (next.requests?.length !== 1) throw Error("probe_requires_one_call");
    const call = next.requests[0]; save("broker-delivery.json", call);
    if (call.wireName !== "exec" || call.freeform !== true || call.input !== nativeGateway(command, cwd)) throw Error("probe_refuses_other_native_code");
    nativeCall = { id: "ct_" + randomUUID(), type: "custom_tool_call", call_id: call.callId, name: "exec", input: call.input };
    save("native-call.json", nativeCall); response.output = [nativeCall];
    for (const event of responseEvents(response, "").slice(2)) emit(event);
    phase = "native_call_delivered"; status();
  });
  if (requests !== 2 || !nativeCall || !ownerToken || !session) return Response.json({ error: { message: "probe_no_resubmission" } }, { status: 409 });
  if (req.headers.get("thread-id") !== threadId) return new Response("foreign thread", { status: 409 });
  nativeOutput = body.input?.findLast((i: any) => i.type === "custom_tool_call_output" && i.call_id === nativeCall.call_id);
  const matched = correlateNativeToolResult(nativeCall, nativeOutput ?? {});
  if (!Array.isArray(matched.output) || matched.output.some((b: any) => typeof b.text !== "string" || !["input_text", "output_text", "text"].includes(b.type))) throw Error("native_result_blocks_invalid");
  const content = matched.output.map((b: any) => ({ type: "text", text: b.text }));
  const result = content.flatMap((b: any) => { try { return [JSON.parse(b.text).native_command_result]; } catch { return []; } }).filter(Boolean);
  if (result.length !== 1 || result[0].exit_code !== 0 || result[0].output.trim() !== nonce) throw Error("actual_native_command_did_not_match");
  save("native-result.json", nativeOutput);
  await nativeRpc(socketPath, { method: "owner_complete", token: ownerToken, callId: matched.callId, toolResult: { content } });
  phase = "waiting_for_mcp_completion"; status();
  return waitingResponse(async (emit, response) => {
    const deadline = Date.now() + waitMs;
    while (findSessionByToken(session!.token)?.nativeOwner?.phase !== "completed") {
      if (Date.now() > deadline) throw Error("mcp_completion_not_observed"); await Bun.sleep(50);
    }
    const summary = findSessionByToken(session!.token)!.nativeOwner!.response!;
    save("mcp-completion-summary.json", { response: summary });
    // Actual codex_turn_complete summary, not an invented Web final.
    const final = buildResponseBody(model, summary, "");
    for (const event of responseEvents(final, "").slice(2)) emit(event);
    phase = "mcp_completed"; status();
  });
} });
const env = { ...process.env, CODEX_HOME: codexHome, OPENAI_BASE_URL: "", OPENAI_API_BASE: "", CODEX_API_BASE_URL: "", ISYMCP_PROBE_PROVIDER_KEY: runId };
const proc = spawn("codex", ["-c", 'model_provider="isymcp_probe"', "-c",
  `model_providers.isymcp_probe={name="ISyMCP active native probe",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,env_key="ISYMCP_PROBE_PROVIDER_KEY",stream_idle_timeout_ms=${waitMs + 30000},stream_max_retries=0,request_max_retries=0}`,
  "-c", `model="${model}"`, "-c", `model_catalog_json=${JSON.stringify(join(dir, "model-catalog.json"))}`, "app-server", "--listen", "stdio://"], { env, stdio: ["pipe", "pipe", "pipe"] });
let counter = 0, buffer = ""; const pending = new Map<number, (r: any) => void>();
function request(method: string, params: any): Promise<any> {
  const id = ++counter; return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error("native_rpc_timeout:" + method)); }, 15000);
    pending.set(id, r => { clearTimeout(timer); r.error ? reject(Error(JSON.stringify(r.error))) : resolve(r.result); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
proc.stdout.setEncoding("utf8").on("data", s => {
  buffer += s; for (;;) {
    const index = buffer.indexOf("\n"); if (index < 0) break;
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    try { const message = JSON.parse(line); appendFileSync(join(dir, "native-events.jsonl"), JSON.stringify(message) + "\n", { mode: 0o600 });
      if (pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
      if (message.method === "turn/completed") finish(message);
    } catch {} }
});
proc.stderr.on("data", s => appendFileSync(join(dir, "native-stderr.txt"), s, { mode: 0o600 }));
const timer = setTimeout(() => finish({ timeout: true }), waitMs + 30000);
process.once("SIGTERM", () => finish({ stopped: true })); process.once("SIGINT", () => finish({ stopped: true }));
try {
  await request("initialize", { clientInfo: { name: "isymcp-active-native-probe", version: "1" }, capabilities: null });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
  const thread = await request("thread/start", { model, modelProvider: "isymcp_probe", cwd, ephemeral: true, approvalPolicy: "on-request", sandbox: "read-only" }); threadId = thread.thread.id;
  const turn = await request("turn/start", { threadId, clientUserMessageId: randomUUID(), input: [{ type: "text", text: "Wait for the authorized Codex ISyMCP canary from Chrome. Execute only the single registered native command.", text_elements: [] }] }); turnId = turn.turn.id;
  const final = await finished;
  if (final.params?.turn?.status !== "completed" || !nativeOutput || phase !== "mcp_completed") throw Error(failure ?? "native_probe_not_complete");
  phase = "complete"; status();
  save("receipt.json", { startedAt, completedAt: new Date().toISOString(), backend: "active-codex", client: "cli", threadId, turnId,
    fingerprint: session!.fp, source: findSessionByToken(session!.token)?.nativeOwner?.source, nativeCallId: nativeCall.call_id,
    output: nonce, exit_code: 0, requests, scope: "One real Chrome MCP command; explicit native owner. No generic conversation streaming or App proof." });
} catch (e) { failure = String(e); phase = "failed"; status(); save("failure.json", { failure, threadId, turnId, requests }); process.exitCode = 1; }
finally {
  clearTimeout(timer);
  if (ownerToken) await nativeRpc(socketPath, { method: "owner_revoke", token: ownerToken }).catch(() => {});
  if (session) revokeSession(session.fp);
  if (proc.exitCode === null) { proc.kill("SIGTERM"); const kill = setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 2000); await new Promise<void>(resolve => proc.once("exit", () => { clearTimeout(kill); resolve(); })); }
  server.stop(true);
  await broker.close();
  const hashes: Record<string, string> = {};
  for (const name of ["status.json", "native-call.json", "native-result.json", "native-events.jsonl", "receipt.json", "failure.json", "mcp-completion-summary.json"])
    if (await Bun.file(join(dir, name)).exists()) hashes[name] = createHash("sha256").update(new Uint8Array(await Bun.file(join(dir, name)).arrayBuffer())).digest("hex");
  save("hashes.json", hashes);
}
