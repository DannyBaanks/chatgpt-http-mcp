#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildResponseBody, buildWebStream } from "../src/web-responses";
import { correlateNativeToolResult } from "../src/visible/host";

function arg(name: string): string | undefined {
  const at = Bun.argv.indexOf(`--${name}`);
  return at >= 0 ? Bun.argv[at + 1] : undefined;
}

const client = arg("client") ?? "cli";
const entry = arg("entry") ?? "codex";
const outDir = resolve(arg("evidence-dir") ?? join(tmpdir(), `isymcp-visible-probe-${randomUUID()}`));
if (client !== "cli" && client !== "app") throw new Error("client_must_be_cli_or_app");
if (entry !== "codex" && entry !== "chatgpt") throw new Error("entry_must_be_codex_or_chatgpt");
mkdirSync(outDir, { recursive: true, mode: 0o700 });

const startedAt = new Date().toISOString();
const nonce = `ISYMCP_NATIVE_${randomUUID().replaceAll("-", "")}`;
const model = "gpt-6.1-sol";
const modelCache = JSON.parse(await Bun.file(join(process.env.HOME ?? "/home/danny", ".codex", "models_cache.json")).text());
const modelRow = modelCache.models?.find((row: Record<string, unknown>) => row.slug === model);
if (!modelRow) throw new Error("installed_model_catalog_entry_missing");
const { model_messages: _privateInstructions, availability_nux: _notice, ...safeModelRow } = modelRow;
const catalogPath = join(outDir, "model-catalog.json");
writeFileSync(catalogPath, JSON.stringify({ models: [{
  ...safeModelRow,
  base_instructions: "You are Codex. Follow the current user request and use registered native tools when needed.",
  supported_in_api: true,
  tool_mode: "code_mode_only",
}] }), { mode: 0o600, flag: "wx" });
const calls: Array<Record<string, unknown>> = [];
const events: Array<Record<string, unknown>> = [];
let stderrText = "";
let toolResult: Record<string, unknown> | undefined;
let nativeCall: Record<string, unknown> | undefined;
let responseCount = 0;
let providerError: string | undefined;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (new URL(req.url).pathname !== "/v1/responses" || req.method !== "POST") return new Response("not found", { status: 404 });
  const body = await req.json() as Record<string, any>;
  responseCount++;
  calls.push({ request: responseCount, model: body.model, inputCount: body.input?.length, toolChoice: body.tool_choice ?? null });
  const items = Array.isArray(body.input) ? body.input : [];
  const observedResult = items.findLast((item: Record<string, unknown>) => item.type === "function_call_output") as Record<string, unknown> | undefined;
  if (observedResult && nativeCall && !toolResult) {
    try {
      const matched = correlateNativeToolResult(nativeCall, observedResult);
      toolResult = { call_id: matched.callId, output: matched.output };
    } catch (error) {
      providerError = error instanceof Error ? error.message : String(error);
      return Response.json({ error: { message: providerError } }, { status: 409 });
    }
  }
  let response: Record<string, unknown>;
  if (!toolResult) {
    const call = { id: `fc_${randomUUID()}`, type: "function_call", call_id: `call_${randomUUID()}`, name: "exec_command", arguments: JSON.stringify({ cmd: `printf '%s\\n' '${nonce}'` }) };
    nativeCall = call;
    response = buildResponseBody(body.model, "", "");
    response.output = [call];
    calls.push({ emitted: "function_call", callId: call.call_id, wireName: call.name });
  } else {
    const actual = items.find((item: Record<string, unknown>) => item.type === "function_call_output" && item.call_id === toolResult!.call_id) as Record<string, unknown> | undefined;
    if (!actual || actual.output !== toolResult.output) {
      providerError = "native_output_not_returned_to_provider";
      return Response.json({ error: { message: providerError } }, { status: 409 });
    }
    response = buildResponseBody(body.model, nonce, "");
    calls.push({ received: "function_call_output", callId: actual.call_id, outputMatchesNonce: String(actual.output).includes(nonce) });
  }
  return new Response(buildWebStream(String(body.model), response.output_text as string ?? "", "", response), {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
} });

let proc: ReturnType<typeof spawn> | undefined;
let rpcId = 0;
let stdoutBuffer = "";
let resolveWait: ((message: Record<string, any>) => void) | undefined;
let turnComplete: ((message: Record<string, any>) => void) | undefined;
const pending = new Map<number, (message: Record<string, any>) => void>();
const exitStatus = { code: null as number | null, signal: null as NodeJS.Signals | null };
const stop = () => new Promise<void>(resolve => {
  if (!proc || proc.exitCode !== null) return resolve();
  proc.once("exit", () => resolve());
  proc.kill("SIGTERM");
  setTimeout(() => proc?.kill("SIGKILL"), 1500).unref();
});
function send(payload: Record<string, unknown>): void {
  if (!proc?.stdin?.writable) throw new Error("app_server_stdin_closed");
  proc.stdin.write(`${JSON.stringify(payload)}\n`);
}
function request(method: string, params: Record<string, unknown>, timeoutMs = 12_000): Promise<Record<string, any>> {
  const id = ++rpcId;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`app_server_timeout:${method}`)); }, timeoutMs);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
  });
}
function consumeLine(line: string): void {
  let message: Record<string, any>;
  try { message = JSON.parse(line); } catch { return; }
  if (typeof message.id === "number" && pending.has(message.id)) {
    pending.get(message.id)!(message);
    pending.delete(message.id);
    return;
  }
  if (typeof message.method === "string") {
    events.push({ method: message.method, notification: true });
    if (["item/started", "item/completed", "error"].includes(message.method)) {
      const params = message.params ?? {};
      const item = params.item ?? {};
      events.push({ method: message.method, itemId: item.id ?? null, itemType: item.type ?? null, exitCode: item.exitCode ?? null,
        status: item.status ?? null, error: params.error?.message ?? params.message ?? null,
        output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.slice(0, 500) : undefined });
    }
    if (message.method === "item/completed" && message.params?.item?.type === "commandExecution") {
      const item = message.params.item;
      events.push({ method: message.method, item: item.type, exitCode: item.exitCode ?? null, output: item.aggregatedOutput ?? "" });
    }
    if (message.method === "turn/completed") turnComplete?.(message);
  }
}
const waitTurn = (timeoutMs = 90_000) => new Promise<Record<string, any>>((resolve, reject) => {
  const timer = setTimeout(() => { turnComplete = undefined; reject(new Error("native_turn_timeout")); }, timeoutMs);
  turnComplete = message => { clearTimeout(timer); turnComplete = undefined; resolve(message); };
});

let outcome = "NOT_DEMONSTRATED";
let error: string | undefined;
try {
  if (client !== "cli") throw new Error("desktop_app_ownership_requires_a_live_app_canary");
  if (entry !== "codex") throw new Error("chatgpt_entry_requires_a_verified_browser_source_receipt");

  proc = spawn("codex", [
    "-c", 'model_provider="isymcp_probe"',
    "-c", `model_providers.isymcp_probe={name="ISyMCP local probe",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
    "-c", `model=${JSON.stringify(model)}`,
    "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`,
    "app-server", "--listen", "stdio://",
  ], { env: { ...process.env, OPENAI_BASE_URL: "", CODEX_API_BASE_URL: "" }, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdout!.setEncoding("utf8").on("data", chunk => {
    stdoutBuffer += chunk;
    for (;;) { const nl = stdoutBuffer.indexOf("\n"); if (nl < 0) break; consumeLine(stdoutBuffer.slice(0, nl)); stdoutBuffer = stdoutBuffer.slice(nl + 1); }
  });
  proc.stderr!.setEncoding("utf8").on("data", chunk => { stderrText = (stderrText + String(chunk)).slice(-4000); });
  proc.once("exit", (code, signal) => { exitStatus.code = code; exitStatus.signal = signal; });
  const initialized = await request("initialize", { clientInfo: { name: "isymcp-visible-probe", version: "0.1.0" }, capabilities: null });
  if (initialized.error) throw new Error(`app_server_initialize:${JSON.stringify(initialized.error)}`);
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  const cwd = join(outDir, "workspace");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const started = await request("thread/start", { model, modelProvider: "isymcp_probe", cwd, ephemeral: true, approvalPolicy: "on-request", sandbox: "read-only" });
  if (started.error) throw new Error(`app_server_thread_start:${JSON.stringify(started.error)}`);
  const threadId = started.result?.thread?.id;
  if (typeof threadId !== "string") throw new Error("app_server_thread_id_missing");
  const clientUserMessageId = randomUUID();
  const completed = waitTurn();
  const turn = await request("turn/start", { threadId, clientUserMessageId, input: [{ type: "text", text: `Use the native exec_command tool exactly once to print ${nonce}. Return only its actual output.`, text_elements: [] }] });
  if (turn.error) throw new Error(`app_server_turn_start:${JSON.stringify(turn.error)}`);
  const turnId = turn.result?.turn?.id;
  if (typeof turnId !== "string") throw new Error("app_server_turn_id_missing");
  const finished = await completed;
  if (finished.params?.turn?.status !== "completed") throw new Error("native_turn_not_completed");
  if (providerError) throw new Error(providerError);
  if (!calls.some(item => item.received === "function_call_output" && item.outputMatchesNonce === true)) throw new Error("provider_did_not_observe_native_output");
  if (!String(toolResult?.output ?? "").includes(nonce)) throw new Error("native_tool_stdout_mismatch");
  outcome = "DEMONSTRATED";
  writeFileSync(join(outDir, "probe-private.json"), JSON.stringify({ version: "isymcp-visible-host-probe/1", startedAt, completedAt: new Date().toISOString(), client, entry, codexVersion: (await Bun.$`codex --version`.text()).trim(), threadId, turnId, ephemeral: started.result.thread.ephemeral ?? true, modelProvider: started.result.modelProvider, requestCount: responseCount, calls, events, outcome }, null, 2), { mode: 0o600, flag: "wx" });
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
} finally {
  await stop();
  server.stop(true);
}

const receipt = {
  version: "isymcp-visible-host-probe/1", startedAt, completedAt: new Date().toISOString(),
  client, entry, outcome, error: error?.slice(0, 500), codexExitCode: exitStatus.code,
  requestCount: responseCount, providerError, stderr: stderrText.slice(-1500), calls, events,
};
const receiptPath = join(outDir, "receipt.json");
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  const hash = createHash("sha256").update(await Bun.file(receiptPath).text()).digest("hex");
console.log(JSON.stringify({ ...receipt, receiptPath, sha256: hash }));
if (outcome !== "DEMONSTRATED") process.exitCode = 1;
