#!/usr/bin/env bun
// Narrow real-App canary: reuse ONLY the previously verified isolated profile.
// The App owns execution. No CLI app-server is launched by this script.
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { openSync, closeSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createActiveBroker } from "../src/mcp/active-broker";
import { mintNativeSession, nativeGateway, nativeRpc } from "../src/mcp/active-native";
import { findSessionByToken, revokeSession, type CodexSession } from "../src/codex-sessions";
import { buildResponseBody, responseEvents, localAppTitle } from "../src/web-responses";
import { correlateNativeToolResult } from "../src/visible/host";
import { NativeAppTurnGate, readOwnedAppProbeProfile, appProbeStream } from "../src/visible/native-app-probe";

const at = Bun.argv.indexOf("--evidence-dir");
if (at < 0 || !Bun.argv[at + 1]) throw Error("usage: bun scripts/probe-active-isymcp-app.ts --evidence-dir <NEW_PRIVATE_DIR>");
const dir = resolve(Bun.argv[at + 1]); mkdirSync(dir, { mode: 0o700 });
const launchId = "d65a3ab3-a45d-4ddf-9f99-53bfe85ec23a", model = "chatgpt-web/gpt-5.6-sol", port = 33653;
const profile = readOwnedAppProbeProfile({ root: "/home/danny/.isymcp-app/" + launchId, model, port,
  configSha256: "8a70df2a4ca89f35e04ed76a62d20b55c2674604014930ae9d8d097877503b2e" });
const threadId = "01a12f10-6159-7791-b7fb-9744b683a7c8";
const rollout = join(profile.codexHome, "sessions/2026/10/12/rollout-2026-10-12T01-42-45-" + threadId + ".jsonl");
const historical = readFileSync(rollout, "utf8");
const meta = JSON.parse(historical.split("\n")[0]).payload;
if (meta.id !== threadId || meta.originator !== "Codex Desktop" || meta.cli_version !== "0.160.0") throw Error("native_app_writer_not_verified");
const cwd = meta.cwd;
if (cwd !== "/tmp/isymcp-native2-app-native-gateway-20261012/workspace") throw Error("native_app_workspace_changed");
if (!existsSync(cwd)) throw Error("native_app_workspace_missing");
// A fresh Electron directory avoids adopting or removing old Singleton locks.
// The previously authorized Codex home is reused; credentials are never copied.
const reuseApp = Bun.argv.includes("--reuse-app-window");
const electronData = join(dir, "electron"); if (!reuseApp) mkdirSync(electronData, { mode: 0o700 });
const marker = "ISYMCP_APP_CANARY_20261013", nonce = "ISYMCP_APP_NATIVE_" + randomUUID().replaceAll("-", "");
const command = ["printf", "%s\n", nonce], socketPath = join(dir, "owner.sock");
const gate = new NativeAppTurnGate({ threadId, model, marker });
const save = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const waitMs = 1200000, startedAt = new Date().toISOString();
let phase = "waiting_for_app_input", failure: string | undefined, session: CodexSession | undefined, ownerToken: string | undefined, nativeCall: any, nativeOutput: any, requests = 0, browserSource: any;
const status = () => save("status.json", { controllerPid: process.pid, startedAt, updatedAt: new Date().toISOString(), phase, threadId, turnId: gate.owner?.turnId, requests, nonce, fingerprint: session?.fp, failure });
save("intent-" + launchId + ".json", { client: "app", launchId, model });
save("profile-before.json", { configSha256: profile.configSha256, rolloutBytes: Buffer.byteLength(historical), source: meta.originator, version: meta.cli_version });
let finish: (reason: string) => void = () => {};
const finished = new Promise<string>(resolve => { finish = resolve; });
function stream(req: Request, work: (emit: (e: any) => void, response: any) => Promise<void>, ownsTurn = true) {
  return appProbeStream({ signal: req.signal,
    onDisconnect() {
      if (!ownsTurn) return;
      failure = "native_app_disconnected_no_resubmission"; phase = "failed"; status();
      // Fence the capability immediately, before any pending work can deliver.
      if (session) revokeSession(session.fp);
      if (ownerToken) void nativeRpc(socketPath, { method: "owner_revoke", token: ownerToken }).catch(() => {});
      finish("disconnected");
    },
    onError(error) { failure = String(error); phase = "failed"; status(); finish("failed"); },
    async work(send) {
      const emit = (event: any) => { if (!send(event)) throw Error("native_app_disconnected"); };
      const response = buildResponseBody(model, "", ""), initial = { ...response, status: "in_progress", output: [] };
      emit({ type: "response.created", response: initial, sequence_number: 0 });
      emit({ type: "response.in_progress", response: initial, sequence_number: 1 });
      await work(emit, response);
    },
  });
}
const broker = await createActiveBroker(socketPath);
const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, async fetch(req) {
  if (new URL(req.url).pathname === "/healthz") return Response.json({ service: "isymcp-active-app-probe", phase, threadId });
  if (new URL(req.url).pathname !== "/v1/responses" || req.method !== "POST") return new Response("not found", { status: 404 });
  const body: any = await req.json();
  const title = localAppTitle(new Request(req.url, { headers: { "x-isymcp-launch-id": launchId } }), body, dir);
  if (title) return stream(req, async emit => { for (const event of responseEvents(title, "").slice(2)) emit(event); }, false);
  if (phase === "native_complete") return stream(req, async emit => {
    const final = buildResponseBody(model, "Esta ventana es un canario terminado; no es un proveedor de conversación general.", "");
    for (const event of responseEvents(final, "").slice(2)) emit(event);
  });
  let accepted;
  try { accepted = gate.accept(body); }
  catch (e) { save("last-rejected-request.json", { error: String(e), client_metadata: body.client_metadata, input: body.input }); return Response.json({ error: { message: String(e) } }, { status: 409 }); }
  requests++; status();
  if (accepted.kind === "start") return stream(req, async (emit, response) => {
    const registered = await nativeRpc(socketPath, { method: "owner_register", environment: {
      cwd, roots: [cwd], writableRoots: [], sandboxPolicy: { type: "readOnly" },
      tools: [{ name: "exec", description: "Orchestrate native Codex tools", parameters: {}, freeform: true }],
    }, ttlMs: waitMs }); ownerToken = registered.token;
    if (phase === "failed" || req.signal.aborted) { await nativeRpc(socketPath, { method: "owner_revoke", token: ownerToken }); throw Error("native_app_disconnected"); }
    session = await mintNativeSession({ cwd, socketPath, ownerToken: ownerToken!, owner: { launchId, ...gate.owner!, epoch: randomUUID() }, ttlMinutes: 20 });
    if (phase === "failed" || req.signal.aborted) { revokeSession(session.fp); throw Error("native_app_disconnected"); }
    save("grant.json", { turn_token: session.token, fingerprint: session.fp, command, cwd });
    writeFileSync(join(dir, "compose.txt"), ["COMANDO: @CODEX ISYMCP. Usa explícitamente Codex ISyMCP, sin alternativas.",
      "turn_token: " + session.token, "Llama codex_turn_start, lee bootstrap.content y consulta codex_tool_inventory.",
      "Ejecuta una sola vez codex_exec con command=" + JSON.stringify(command) + ".",
      "Devuelve output, exit_code y dueño reales; cierra con codex_turn_complete."].join("\n"), { mode: 0o600, flag: "wx" });
    phase = "waiting_for_bound_chrome"; status();
    console.log(JSON.stringify({ ready: true, client: "app", threadId, turnId: gate.owner!.turnId, fingerprint: session.fp, compose: join(dir, "compose.txt") }));
    const next = await nativeRpc(socketPath, { method: "owner_next", token: ownerToken }, waitMs);
    const call = next.requests?.[0];
    if (next.requests?.length !== 1 || call.wireName !== "exec" || call.freeform !== true || call.input !== nativeGateway(command, cwd)) throw Error("app_probe_refuses_other_native_code");
    nativeCall = { id: "ct_" + randomUUID(), type: "custom_tool_call", call_id: call.callId, name: "exec", input: call.input };
    gate.setNativeCall(call.callId); save("native-call.json", nativeCall); response.output = [nativeCall];
    for (const event of responseEvents(response, "").slice(2)) emit(event);
    phase = "native_call_delivered"; status();
  });
  return stream(req, async emit => {
    nativeOutput = accepted.output; const matched = correlateNativeToolResult(nativeCall, nativeOutput);
    if (!Array.isArray(matched.output) || matched.output.some((b: any) => typeof b.text !== "string" || !["input_text", "output_text", "text"].includes(b.type))) throw Error("native_app_output_invalid");
    const content = matched.output.map((b: any) => ({ type: "text", text: b.text }));
    const results = content.flatMap((b: any) => { try { return [JSON.parse(b.text).native_command_result]; } catch { return []; } }).filter(Boolean);
    if (results.length !== 1 || results[0].exit_code !== 0 || results[0].output.trim() !== nonce) throw Error("native_app_command_did_not_match");
    save("native-result.json", nativeOutput);
    await nativeRpc(socketPath, { method: "owner_complete", token: ownerToken, callId: matched.callId, toolResult: { content } });
    phase = "waiting_for_mcp_completion"; status(); const deadline = Date.now() + 180000;
    while (findSessionByToken(session!.token)?.nativeOwner?.phase !== "completed") { if (Date.now() > deadline) throw Error("native_app_completion_not_observed"); await Bun.sleep(50); }
    const record = findSessionByToken(session!.token)!; browserSource = record.nativeOwner!.source;
    const summary = record.nativeOwner!.response!; save("mcp-completion-summary.json", { response: summary });
    const final = buildResponseBody(model, summary, ""); for (const event of responseEvents(final, "").slice(2)) emit(event);
    gate.complete(); phase = "mcp_completed"; status();
  });
} });
status();
const env: Record<string, string | undefined> = { ...process.env, CODEX_HOME: profile.codexHome, CODEX_ELECTRON_USER_DATA_PATH: electronData, ISYMCP_LAUNCH_ID: launchId };
delete env.OPENAI_BASE_URL; delete env.OPENAI_API_BASE; delete env.CODEX_API_BASE_URL;
delete env.ELECTRON_RUN_AS_NODE;
if (!reuseApp) {
  const logFd = openSync(join(dir, "app-launch-stderr.txt"), "a", 0o600);
  const child = spawn("/usr/lib/chatgpt/ChatGPT", ["--user-data-dir=" + electronData, "codex://threads/" + threadId], { env, detached: true, stdio: ["ignore", "ignore", logFd] });
  closeSync(logFd);
  child.once("exit", (code, signal) => save("app-launch-exit.json", { code, signal }));
  child.once("error", e => { failure = String(e); finish("launch_failed"); }); child.unref();
}
console.log(JSON.stringify({ state: phase, client: "app", marker, threadId, profileReused: true, appWindowReused: reuseApp, configChanged: false, authCopied: false, port }));
const watcher = setInterval(() => {
  if (phase !== "mcp_completed" || !nativeCall) return;
  const fresh = readFileSync(rollout, "utf8").slice(historical.length);
  const rows = fresh.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const output = rows.find(r => r.type === "response_item" && r.payload?.type === "custom_tool_call_output" && r.payload.call_id === nativeCall.call_id);
  const done = rows.find(r => r.type === "event_msg" && r.payload?.type === "task_complete" && JSON.stringify(r.payload).includes(nonce));
  if (output && done) { save("native-rollout-scoped.json", rows); phase = "native_complete"; status(); finish("complete"); }
}, 250);
const timer = setTimeout(() => finish("expired"), waitMs + 30000);
process.once("SIGTERM", () => finish("stopped")); process.once("SIGINT", () => finish("stopped"));
try {
  const outcome = await finished;
  if (outcome !== "complete") throw Error(failure ?? "native_app_probe_" + outcome);
  readOwnedAppProbeProfile({ root: profile.root, configSha256: profile.configSha256, model, port });
  save("receipt.json", { startedAt, completedAt: new Date().toISOString(), client: "app", backend: "active-codex", version: meta.cli_version,
    threadId, turnId: gate.owner!.turnId, nativeCallId: nativeCall.call_id, source: browserSource, nonce, exit_code: 0, requests, configSha256: profile.configSha256,
    scope: "Actual installed Desktop App owns native execution. One Chrome ISyMCP canary; no general multi-turn provider or streaming claim." });
} catch (e) { failure = String(e); phase = "failed"; status(); save("failure.json", { failure, owner: gate.owner }); process.exitCode = 1; }
finally {
  clearInterval(watcher); clearTimeout(timer);
  if (ownerToken) await nativeRpc(socketPath, { method: "owner_revoke", token: ownerToken }).catch(() => {});
  if (session) revokeSession(session.fp);
  await broker.close(); server.stop(true);
  const hashes: Record<string, string> = {};
  for (const name of ["status.json", "profile-before.json", "native-call.json", "native-result.json", "native-rollout-scoped.json", "receipt.json", "failure.json", "mcp-completion-summary.json"])
    if (await Bun.file(join(dir, name)).exists()) hashes[name] = createHash("sha256").update(new Uint8Array(await Bun.file(join(dir, name)).arrayBuffer())).digest("hex");
  save("hashes.json", hashes);
}
