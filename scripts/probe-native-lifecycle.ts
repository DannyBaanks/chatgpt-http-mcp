#!/usr/bin/env bun
// Real installed CLI lifecycle; deterministic local provider, no Web claim.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildResponseBody, buildWebStream } from "../src/web-responses";

const index = Bun.argv.indexOf("--evidence-dir");
if (index < 0 || !Bun.argv[index + 1]) throw Error("new_private_evidence_directory_required");
const dir = resolve(Bun.argv[index + 1]); mkdirSync(dir, { mode: 0o700 });
const cwd = join(dir, "workspace"), home = join(dir, "codex-home"); mkdirSync(cwd, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
const model = "gpt-6.1-sol", nonce = "ISYMCP_RESUME_" + randomUUID().replaceAll("-", ""), key = randomUUID();
const cache = await Bun.file(join(process.env.HOME!, ".codex/models_cache.json")).json();
const row = cache.models.find((r: any) => r.slug === model); if (!row) throw Error("model_catalog_entry_missing");
const { model_messages: _private, availability_nux: _notice, ...safe } = row;
const save = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
save("model-catalog.json", { models: [{ ...safe, base_instructions: "This is a local lifecycle probe.", supported_in_api: true }] });
let mode = "wait", requests = 0, providerStarted = false;
let closePending: (() => void) | undefined;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
  if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/responses" || req.headers.get("authorization") !== "Bearer " + key) return new Response("foreign request", { status: 403 });
  await req.json(); requests++; providerStarted = true;
  if (mode === "finish") { const response = buildResponseBody(model, nonce, ""); return new Response(buildWebStream(model, nonce, "", response), { headers: { "content-type": "text/event-stream" } }); }
  return new Response(new ReadableStream({ start(controller) {
    const response = { ...buildResponseBody(model, "", ""), status: "in_progress", output: [] };
    controller.enqueue(new TextEncoder().encode(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response, sequence_number: 0 })}\n\n`));
    closePending = () => { try { controller.close(); } catch {} };
  } }), { headers: { "content-type": "text/event-stream" } });
} });
const proc = spawn("codex", ["-c", 'model_provider="isymcp_lifecycle"', "-c",
  `model_providers.isymcp_lifecycle={name="Local lifecycle canary",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,env_key="ISYMCP_LIFECYCLE_KEY",stream_max_retries=0,request_max_retries=0}`,
  "-c", `model="${model}"`, "-c", `model_catalog_json=${JSON.stringify(join(dir, "model-catalog.json"))}`, "app-server", "--listen", "stdio://"], {
    env: { ...process.env, CODEX_HOME: home, OPENAI_BASE_URL: "", OPENAI_API_BASE: "", CODEX_API_BASE_URL: "", ISYMCP_LIFECYCLE_KEY: key }, stdio: ["pipe", "pipe", "pipe"],
  });
let id = 0, buffer = ""; const pending = new Map<number, (m: any) => void>(), events: any[] = [];
function request(method: string, params: any): Promise<any> {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(requestId); reject(Error("rpc_timeout:" + method)); }, 15000);
    pending.set(requestId, m => { clearTimeout(timeout); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
}
proc.stdout.setEncoding("utf8").on("data", data => {
  buffer += data; for (;;) {
    const newline = buffer.indexOf("\n"); if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    try { const message = JSON.parse(line); appendFileSync(join(dir, "native-events.jsonl"), line + "\n", { mode: 0o600 });
      if (pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
      else events.push(message);
    } catch {} }
});
proc.stderr.on("data", data => appendFileSync(join(dir, "native-stderr.txt"), data, { mode: 0o600 }));
async function until(predicate: () => any) {
  const deadline = Date.now() + 15000;
  for (;;) { const result = predicate(); if (result) return result; if (Date.now() > deadline) throw Error("native_notification_timeout"); await Bun.sleep(25); }
}
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
try {
  await request("initialize", { clientInfo: { name: "isymcp-lifecycle-probe", version: "1" }, capabilities: null });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
  const opened = await request("thread/start", { model, modelProvider: "isymcp_lifecycle", cwd, ephemeral: false, sandbox: "read-only", approvalPolicy: "on-request" });
  const threadId = opened.thread.id;
  const first = await request("turn/start", { threadId, clientUserMessageId: randomUUID(), input: input("Wait for an explicit cancellation. This is a lifecycle fixture.") });
  await until(() => providerStarted);
  await request("turn/interrupt", { threadId, turnId: first.turn.id });
  const interrupted = await until(() => events.find(e => e.method === "turn/completed" && e.params?.turn?.id === first.turn.id));
  if (interrupted.params.turn.status !== "interrupted") throw Error("native_interrupt_not_confirmed");
  closePending?.(); mode = "finish";
  const resumed = await request("thread/resume", { threadId, model, modelProvider: "isymcp_lifecycle", cwd, sandbox: "read-only", approvalPolicy: "on-request" });
  if (resumed.thread.id !== threadId) throw Error("native_resume_changed_thread");
  const second = await request("turn/start", { threadId, clientUserMessageId: randomUUID(), input: input("Return the local fixture marker after resuming this exact thread.") });
  const completed = await until(() => events.find(e => e.method === "turn/completed" && e.params?.turn?.id === second.turn.id));
  if (completed.params.turn.status !== "completed" || !JSON.stringify(events).includes(nonce) || requests !== 2) throw Error("native_resumed_turn_not_verified");
  const read = await request("thread/read", { threadId, includeTurns: true });
  if (read.thread.id !== threadId || !JSON.stringify(read).includes(nonce)) throw Error("native_history_not_retained");
  save("receipt.json", { outcome: "DEMONSTRATED", client: "cli", writerPid: proc.pid, threadId, interruptedTurnId: first.turn.id, resumedTurnId: second.turn.id,
    interruptedStatus: interrupted.params.turn.status, completedStatus: completed.params.turn.status, requests, nonce,
    scope: "One native writer, interrupted pending response, exact persisted thread resumed. Deterministic local provider; no Web, MCP-call or running-process cancellation claim." });
  console.log(JSON.stringify({ outcome: "DEMONSTRATED", threadId, interrupted: true, resumedSameThread: true, requests }));
} catch (e) { save("failure.json", { failure: String(e), requests }); process.exitCode = 1; console.error(String(e)); }
finally {
  closePending?.(); server.stop(true); proc.kill("SIGTERM");
  const kill = setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 1500);
  if (proc.exitCode === null) await new Promise<void>(resolve => proc.once("exit", () => resolve())); clearTimeout(kill);
  const hashes: Record<string, string> = {};
  for (const name of ["receipt.json", "failure.json", "native-events.jsonl", "native-stderr.txt"]) if (await Bun.file(join(dir, name)).exists()) hashes[name] = createHash("sha256").update(new Uint8Array(await Bun.file(join(dir, name)).arrayBuffer())).digest("hex");
  save("hashes.json", hashes);
}
