#!/usr/bin/env bun
// Agent-mediated capability proof. This controller NEVER executes commands.
// Its registered Codex owner must perform the one delivered canary with its
// real native tool and supply that unmodified result. No autonomous UI API is
// claimed. Tokens remain in owner-only local files, not console output.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createActiveBroker } from "../src/mcp/active-broker";
import { bindNativeSource, mintNativeSession, nativeGateway, nativeRpc } from "../src/mcp/active-native";
import { findSessionByToken, revokeSession, type CodexSession } from "../src/codex-sessions";
import { canaryCommand, publishCanaryResult } from "../src/mcp/current-owner-canary";
import { securePrivatePath } from "../src/platform/private-path";

const [operation, ...args] = process.argv.slice(2);
function option(name: string) {
  const i = args.indexOf(name), value = args[i + 1];
  if (i < 0 || !value || value.startsWith("--")) throw Error("probe_option_required:" + name);
  return value;
}
const directory = option("--directory");
if (!isAbsolute(directory)) throw Error("probe_directory_requires_absolute_path");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function privateJson(name: string) {
  const file = join(directory, name), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || stat.mode & 0o077)))
    throw Error("probe_private_file_required");
  return JSON.parse(readFileSync(file, "utf8"));
}
function save(name: string, value: unknown) {
  const file = join(directory, name);
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  securePrivatePath(file, false);
}
if (operation === "result") {
  const grant = privateJson("owner-private.json");
  if (process.env.CODEX_THREAD_ID !== grant.owner.threadId) throw Error("probe_foreign_execution_owner");
  publishCanaryResult(directory, JSON.parse(option("--result-json")));
  console.log(JSON.stringify({ published: true, fingerprint: grant.fingerprint }));
} else if (operation === "cancel") {
  const grant = privateJson("owner-private.json");
  revokeSession(grant.fingerprint);
  await nativeRpc(grant.socket, { method: "owner_revoke", token: grant.token });
  console.log(JSON.stringify({ cancelled: true, fingerprint: grant.fingerprint }));
} else if (operation === "bind") {
  const grant = privateJson("owner-private.json");
  const url = option("--url"), messageId = option("--message-id");
  bindNativeSource(grant.fingerprint, { url, messageId });
  save("source.json", { url, messageId });
  console.log(JSON.stringify({ bound: true, fingerprint: grant.fingerprint, url, messageId }));
} else if (operation === "status") {
  console.log(JSON.stringify(privateJson("status.json"), null, 2));
} else if (operation === "start") {
  const threadId = option("--thread-id"), turnId = option("--turn-id"), cwd = realpathSync(option("--cwd"));
  if (process.platform !== "linux" || !uuid.test(threadId) || !uuid.test(turnId) ||
      process.env.CODEX_THREAD_ID !== threadId || process.env.CODEX_PERMISSION_PROFILE !== ":danger-full-access")
    throw Error("probe_requires_current_linux_codex_owner_full_access");
  if (existsSync(directory)) throw Error("probe_directory_exists_no_resubmission");
  mkdirSync(directory, { mode: 0o700 });
  const socket = join(directory, "owner.sock"), marker = "ISYMCP_NATIVE_" + randomUUID().replaceAll("-", "");
  const command = canaryCommand(marker), owner = { launchId: randomUUID(), threadId, turnId, epoch: randomUUID() };
  const broker = await createActiveBroker(socket);
  let session: CodexSession | undefined, token: string | undefined, stopped = false;
  const deadline = Date.now() + 10 * 60000;
  const status = (phase: string, extra: Record<string, unknown> = {}) => save("status.json", {
    phase, updatedAt: new Date().toISOString(), scope: "agent-mediated-fixed-canary", owner, marker, ...extra,
  });
  const stop = () => { stopped = true; void broker.close(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    const registered = await nativeRpc(socket, { method: "owner_register", ttlMs: 10 * 60000,
      environment: { cwd, roots: [cwd], writableRoots: [], sandboxPolicy: { type: "dangerFullAccess" },
        executionGrant: { kind: "current-turn-canary", marker },
        tools: [{ name: "exec", description: "Actual owning Codex code-mode gateway; fixed canary only", freeform: true }] } });
    token = registered.token;
    session = await mintNativeSession({ cwd, socketPath: socket, ownerToken: token!, owner, ttlMinutes: 10,
      canary: { marker, hostSandbox: "dangerFullAccess" } });
    save("owner-private.json", { token, fingerprint: session.fp, turn_token: session.token, socket, owner, cwd });
    const compose = [
      "Prueba autorizada del navegador integrado de Codex. Usa únicamente el conector Codex ISyMCP seleccionado.",
      "turn_token: " + session.token,
      "Llama codex_turn_start, lee bootstrap.content y consulta codex_tool_inventory.",
      "ID de prueba: " + marker + ".",
      "La sesión autoriza únicamente el argv exacto publicado por codex_tool_inventory en limits.allowed_command. Copia ese array sin reconstruirlo ni modificarlo y úsalo como command de codex_exec.",
      "Invócalo una sola vez. Espera su resultado real y cierra con codex_turn_complete incluyendo la salida exacta.",
      "No uses alternativas ni reintentes errores de conectividad. No ejecutes otros comandos ni consultes archivos.",
    ].join("\n");
    const composePath = join(directory, "compose-private.txt");
    writeFileSync(composePath, compose, { mode: 0o600 }); securePrivatePath(composePath, false);
    status("waiting_for_bound_browser", { fingerprint: session.fp });
    console.log(JSON.stringify({ ready: true, directory, marker, fingerprint: session.fp }));
    const next = await nativeRpc(socket, { method: "owner_next", token }, 10 * 60000);
    if (stopped || !findSessionByToken(session.token)) throw Error("probe_cancelled");
    const call = next.requests?.[0];
    if (next.requests?.length !== 1 || call.wireName !== "exec" || call.input !== nativeGateway(command, cwd))
      throw Error("probe_unexpected_native_delivery");
    save("delivery.json", { callId: call.callId, wireName: call.wireName, command, cwd,
      inputSha256: createHash("sha256").update(call.input).digest("hex") });
    status("waiting_for_real_native_result", { callId: call.callId });
    console.log(JSON.stringify({ pending: true, callId: call.callId, command, cwd }));
    const resultPath = join(directory, "native-result.json");
    while (!existsSync(resultPath)) {
      if (stopped || !findSessionByToken(session.token)) throw Error("probe_cancelled");
      if (Date.now() > deadline) throw Error("probe_native_result_missing_no_resubmission");
      await Bun.sleep(100);
    }
    const result = privateJson("native-result.json");
    const lines = typeof result.output === "string" ? result.output.trim().split("\n") : [];
    const nativeCallId = lines[1]?.replace(/^ISYMCP_NATIVE_CALL_ID:/, "");
    if (result.exit_code !== 0 || lines.length !== 2 || lines[0] !== marker ||
        !lines[1].startsWith("ISYMCP_NATIVE_CALL_ID:") || !/^(exec-|call_)[a-zA-Z0-9_-]+$/.test(nativeCallId))
      throw Error("probe_native_result_invalid");
    await nativeRpc(socket, { method: "owner_complete", token, callId: call.callId,
      toolResult: { content: [{ type: "text", text: JSON.stringify({ native_command_result: result }) }] } });
    status("waiting_for_mcp_completion", { nativeCallId, callId: call.callId });
    while (findSessionByToken(session.token)?.nativeOwner?.phase !== "completed") {
      if (stopped || !findSessionByToken(session.token)) throw Error("probe_cancelled");
      if (Date.now() > deadline) throw Error("probe_mcp_completion_missing_no_resubmission");
      await Bun.sleep(100);
    }
    const completed = findSessionByToken(session.token)!;
    save("receipt.json", { scope: "agent-mediated-fixed-canary", owner, source: completed.nativeOwner!.source,
      marker, nativeCallId, brokerCallId: call.callId, output: result.output, exit_code: result.exit_code,
      mcpCompleted: true, nativeHostRecordVerification: "required-separately", autonomous: false });
    status("mcp_completed_host_record_verification_required", { nativeCallId });
    console.log(JSON.stringify({ mcpCompleted: true, nativeCallId, autonomous: false }));
  } catch (error) {
    const reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "probe_failed";
    status(reason === "probe_cancelled" ? "cancelled" : "failed", {
      reason, ...(reason === "probe_cancelled" ? { processTerminationConfirmed: false } : {}),
    });
    process.exitCode = reason === "probe_cancelled" ? 0 : 1;
  } finally {
    if (session) revokeSession(session.fp);
    if (token) await nativeRpc(socket, { method: "owner_revoke", token }).catch(() => {});
    if (!stopped) await broker.close();
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  }
} else throw Error("usage: probe-current-owner-browser start|bind|result|cancel|status --directory PATH [options]");
