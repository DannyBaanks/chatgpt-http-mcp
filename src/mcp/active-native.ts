// A narrow protocol-5 adapter for an explicitly registered active Codex owner.
// No local command runner, default owner, endpoint discovery or fallback here.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { bridgeHome, findSessionByToken, isExpired, mintSession, resolveWithinReal, revokeSession, updateSession, type CodexSession } from "../codex-sessions";
import { capabilities, shapesFor, WIRE_ALIASES, type ToolName } from "./catalog";
import { readMcpBootstrap } from "./bootstrap";
import { isWindowsPipePath, localIpcPath } from "../platform/ipc";
import { canaryCommand, validCanaryEnvironment, type CurrentOwnerCanary } from "./current-owner-canary";

type Owner = NonNullable<CodexSession["nativeOwner"]>;
const supported: ToolName[] = ["codex_turn_start", "codex_tool_inventory", "codex_exec", "codex_tool_call", "codex_turn_complete"];
const json = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const metadata = (session: CodexSession) => ({ fp: session.fp, cwd: session.cwd, writable: session.writable,
  backend: "active-codex", owner: session.nativeOwner!.owner, source: session.nativeOwner!.source,
  ...(session.nativeOwner!.canary ? { execution_scope: "fixed-canary", host_sandbox: session.nativeOwner!.canary.hostSandbox } : {}) });

function socketIdentity(path: string) {
  if (!isAbsolute(path)) throw Error("native_socket_requires_absolute_path");
  const endpoint = localIpcPath(path);
  if (process.platform === "win32") {
    if (!isWindowsPipePath(endpoint)) throw Error("native_socket_not_private_owned_socket");
    const socketInode = Number.parseInt(createHash("sha256").update(endpoint.toLowerCase()).digest("hex").slice(0, 12), 16);
    return { socketDevice: 0, socketInode };
  }
  const stat = lstatSync(endpoint);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw Error("native_socket_not_private_owned_socket");
  return { socketDevice: stat.dev, socketInode: stat.ino };
}
export function nativeRpc(socketPath: string, payload: Record<string, unknown>, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = randomUUID(), socket = createConnection(localIpcPath(socketPath));
    let raw = "", settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(Error("native_owner_timeout_no_resubmission")), timeoutMs);
    socket.on("connect", () => socket.write(JSON.stringify({ id, ...payload }) + "\n"));
    socket.on("data", chunk => {
      raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) finish(Error("native_owner_result_too_large"));
    });
    socket.on("error", () => finish(Error("native_owner_unavailable")));
    socket.on("end", () => {
      try {
        const reply = JSON.parse(raw);
        if (reply.id !== id) throw Error("native_owner_reply_id_mismatch");
        if (reply.error) throw Error("native_owner_rejected"); // Do not echo private owner capability.
        finish(undefined, reply.result);
      } catch (e) { finish(e instanceof Error ? e : Error("native_owner_invalid_reply")); }
    });
    socket.on("close", () => { if (!settled) finish(Error("native_owner_connection_closed")); });
  });
}
async function rpc(owner: Owner, payload: Record<string, unknown>, timeoutMs?: number) {
  const identity = socketIdentity(owner.socketPath);
  if (identity.socketDevice !== owner.socketDevice || identity.socketInode !== owner.socketInode) throw Error("native_owner_socket_replaced");
  return nativeRpc(owner.socketPath, payload, timeoutMs);
}
function validateEnvironment(session: CodexSession, environment: any) {
  if (!environment || realpathSync(environment.cwd) !== realpathSync(session.cwd) ||
      !Array.isArray(environment.tools) || !environment.tools.some((t: any) => t.name === "exec" && t.freeform === true)) throw Error("native_owner_environment_mismatch");
  if (session.nativeOwner?.canary) {
    if (session.writable || !validCanaryEnvironment(environment) ||
        environment.executionGrant.marker !== session.nativeOwner.canary.marker ||
        environment.sandboxPolicy.type !== session.nativeOwner.canary.hostSandbox) throw Error("native_canary_environment_mismatch");
    return;
  }
  if (environment.executionGrant !== undefined) throw Error("native_canary_grant_required");
  // This first adapter is read-only; broader native grants require a separate contract.
  if (session.writable || environment.sandboxPolicy?.type !== "readOnly" || !Array.isArray(environment.writableRoots) || environment.writableRoots.length !== 0) throw Error("native_owner_read_only_required");
}
async function claim(session: CodexSession) {
  const owner = session.nativeOwner!;
  const activityId = "activity_" + randomUUID().replaceAll("-", "");
  const binding = await rpc(owner, { method: "claim", token: owner.ownerToken, activityId, contract: "native" });
  try { validateEnvironment(session, binding.environment); }
  catch (e) { await rpc(owner, { method: "activity_complete", token: owner.ownerToken, activityId }).catch(() => {}); throw e; }
  if (typeof binding.bindingId !== "string" || binding.activityId !== activityId) throw Error("native_owner_claim_mismatch");
  return { bindingId: binding.bindingId, activityId };
}
async function releaseActivity(owner: Owner, activityId: string) {
  await rpc(owner, { method: "activity_complete", token: owner.ownerToken, activityId });
}
export async function mintNativeSession(options: { cwd: string; socketPath: string; ownerToken: string; owner: Owner["owner"]; ttlMinutes: number; canary?: CurrentOwnerCanary }) {
  const identity = socketIdentity(options.socketPath);
  if (!Number.isFinite(options.ttlMinutes) || options.ttlMinutes <= 0 || options.ttlMinutes > 20 || !options.ownerToken.startsWith("turn_") ||
      Object.values(options.owner).length !== 4 || Object.values(options.owner).some(v => typeof v !== "string" || v.length < 8)) throw Error("invalid_native_owner_registration");
  const status = await nativeRpc(options.socketPath, { method: "owner_status" });
  if (status.protocolVersion !== 5 || status.acceptingExternalOwners !== true) throw Error("unsupported_native_broker_protocol");
  if (options.canary && (status.currentTurnCanary !== true || options.canary.hostSandbox !== "dangerFullAccess")) throw Error("unsupported_native_canary_grant");
  if (options.canary) canaryCommand(options.canary.marker);
  const session = mintSession(options.cwd, { label: "active-codex:" + options.owner.threadId, ttlHours: options.ttlMinutes / 60 });
  const registered = updateSession(session.fp, s => { s.nativeOwner = { ...identity, socketPath: options.socketPath, ownerToken: options.ownerToken, owner: options.owner, phase: "prepared", ...(options.canary ? { canary: options.canary } : {}) }; });
  try {
    const binding = await claim(registered); await releaseActivity(registered.nativeOwner!, binding.activityId);
  } catch (error) { revokeSession(registered.fp); throw error; }
  return registered;
}
export function bindNativeSource(fp: string, source: { url: string; messageId: string }) {
  const url = new URL(source.url);
  if (url.origin !== "https://chatgpt.com" || !/^\/c\/[a-zA-Z0-9-]+$/.test(url.pathname) || url.search || url.hash ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(source.messageId)) throw Error("verified_native_browser_source_required");
  return updateSession(fp, s => {
    if (!s.nativeOwner || s.nativeOwner.phase !== "prepared" || isExpired(s)) throw Error("native_source_already_bound_or_expired");
    s.nativeOwner.source = source; s.nativeOwner.phase = "active";
  });
}
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function nativeCommandLine(command: string[]): string {
  if (process.platform !== "win32") return command.map(shellQuote).join(" ");
  const argv = Buffer.from(JSON.stringify(command), "utf8").toString("base64");
  const script = `$__isymcp_json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${argv}')); $__isymcp_argv = @($__isymcp_json | ConvertFrom-Json); $__isymcp_exe = [string]$__isymcp_argv[0]; $__isymcp_args = @($__isymcp_argv | Select-Object -Skip 1); & $__isymcp_exe @__isymcp_args; $__isymcp_success = $?; $__isymcp_exit = Get-Variable LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue; if ($null -ne $__isymcp_exit) { exit $__isymcp_exit }; if ($__isymcp_success) { exit 0 } else { exit 1 }`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}
export function nativeGateway(command: string[], cwd: string): string {
  const cmd = nativeCommandLine(command);
  const exec = { cmd, workdir: cwd, yield_time_ms: 1000, max_output_tokens: 8000, tty: false };
  const shell = { command: cmd, workdir: cwd, timeout_ms: 60000 };
  return [
    'if (typeof ALL_TOOLS === "undefined" || !Array.isArray(ALL_TOOLS)) throw new Error("Native command registry unavailable");',
    'const candidates = ["exec_command", "shell_command"].filter(name => ALL_TOOLS.some(t => t.name === name));',
    'if (candidates.length !== 1 || typeof tools[candidates[0]] !== "function") throw new Error("Native command tool unavailable or ambiguous");',
    `const commandInput = candidates[0] === "exec_command" ? ${JSON.stringify(exec)} : ${JSON.stringify(shell)};`,
    "const result = await tools[candidates[0]](commandInput);",
    "text({native_command_result: result});",
  ].join("\n");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value);
}
async function execute(session: CodexSession, args: Record<string, unknown>, callId?: string) {
  if (args.background === true) throw Error("native_background_unsupported_use_inventory");
  const command = args.command as string[];
  if (!Array.isArray(command) || !command.length || command.some(c => typeof c !== "string" || !c || c.includes("\0"))) throw Error("invalid_native_argv");
  const cwd = resolveWithinReal(session.cwd, typeof args.cwd === "string" ? args.cwd : ".");
  if (!cwd || !existsSync(cwd) || !lstatSync(cwd).isDirectory()) throw Error("native_cwd_outside_workspace_or_missing");
  if (session.nativeOwner?.canary && (cwd !== realpathSync(session.cwd) ||
      JSON.stringify(command) !== JSON.stringify(canaryCommand(session.nativeOwner.canary.marker)))) throw Error("native_canary_command_required");
  const signature = createHash("sha256").update(canonical({ command, cwd })).digest("hex");
  const identity = createHash("sha256").update(callId ?? signature).digest("hex");
  const directory = join(bridgeHome(), "native-call-journal", session.fp);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const journal = join(directory, identity + ".json");
  try { writeFileSync(journal, JSON.stringify({ signature, phase: "pending" }), { mode: 0o600, flag: "wx" }); }
  catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const prior = JSON.parse(readFileSync(journal, "utf8"));
    if (prior.signature !== signature) throw Error("native_call_id_arguments_changed");
    if (prior.phase !== "complete") throw Error("native_call_pending_or_uncertain_no_resubmission");
    return json({ ...prior.result, replayed: true });
  }
  const owner = session.nativeOwner!; let binding: Awaited<ReturnType<typeof claim>> | undefined;
  try {
    binding = await claim(session);
    const out = await rpc(owner, { method: "invoke", bindingId: binding.bindingId, wireName: "exec", freeform: true, input: nativeGateway(command, cwd) }, 60000);
    if (out?.isError) throw Error("native_tool_returned_error");
    const blocks = out?.content?.filter((c: any) => c.type === "text" && typeof c.text === "string");
    const results = (blocks ?? []).flatMap((c: any) => { try { const r = JSON.parse(c.text); return r.native_command_result ? [r.native_command_result] : []; } catch { return []; } });
    if (results.length !== 1 || typeof results[0].output !== "string" || !(results[0].exit_code === null || Number.isInteger(results[0].exit_code))) throw Error("native_result_shape_mismatch");
    const actual = results[0];
    const result = { ...metadata(session), command, cwd, executed: actual.exit_code !== null, output: actual.output, exit_code: actual.exit_code, native_result: actual };
    writeFileSync(journal, JSON.stringify({ signature, phase: "complete", result }), { mode: 0o600 });
    return json(result);
  } catch (e) {
    writeFileSync(journal, JSON.stringify({ signature, phase: "uncertain" }), { mode: 0o600 }); throw e;
  } finally { if (binding) await releaseActivity(owner, binding.activityId).catch(() => {}); }
}
export async function routeNativeTool(session: CodexSession, tool: ToolName, input: Record<string, unknown>, contract: "native" | "safe" = "native") {
  try {
    session = findSessionByToken(session.token)!;
    if (!session?.nativeOwner) throw Error("native_session_revoked");
    // The rendered browser message ID appears only AFTER submission. Bootstrap
    // may wait for the local controller to bind it; execution never gets this
    // exception and remains forbidden while prepared.
    if (tool === "codex_turn_start" && session.nativeOwner.phase === "prepared") {
      const deadline = Date.now() + 30000;
      while (session.nativeOwner.phase === "prepared" && !isExpired(session) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const refreshed = findSessionByToken(session.token);
        if (!refreshed?.nativeOwner) throw Error("native_session_revoked");
        session = refreshed;
      }
    }
    if (isExpired(session)) throw Error("native_session_expired");
    if (session.nativeOwner.phase === "completed") throw Error("native_session_completed");
    if (session.nativeOwner.phase !== "active" || !session.nativeOwner.source) throw Error("native_source_not_bound");
    const owner = session.nativeOwner;
    if (tool === "codex_exec") return await execute(session, input);
    if (tool === "codex_tool_call") {
      const name = WIRE_ALIASES[String(input.wire_name ?? "")];
      if (name !== "codex_exec" && name !== "codex_tool_inventory") throw Error("native_tool_unsupported_use_inventory");
      let arguments_ = input.arguments;
      if (arguments_ === undefined && typeof input.input === "string") arguments_ = JSON.parse(input.input);
      const key = contract === "safe" ? "request_id" : "turn_token";
      const parsed = z.object(shapesFor(contract)[name]).parse({ ...(arguments_ as any), [key]: session.token });
      return name === "codex_exec" ? await execute(session, parsed, typeof input.call_id === "string" ? input.call_id : undefined) : await routeNativeTool(session, name, parsed, contract);
    }
    if (tool === "codex_turn_complete") {
      if (typeof input.response !== "string" || !input.response.trim()) throw Error("native_completion_response_required");
      const revision = await rpc(owner, { method: "owner_completion_fence_begin", token: owner.ownerToken });
      if (!Number.isInteger(revision)) throw Error("native_calls_pending_no_completion");
      const committed = await rpc(owner, { method: "owner_completion_fence_commit", token: owner.ownerToken, revision });
      if (committed?.committed !== true) throw Error("native_completion_fence_failed");
      updateSession(session.fp, s => { s.nativeOwner!.phase = "completed"; s.nativeOwner!.response = input.response as string; });
      return json({ completed: true, ...metadata(session), process_lifetime: "owned-by-codex" });
    }
    if (tool !== "codex_turn_start" && tool !== "codex_tool_inventory") throw Error("native_tool_unsupported_use_inventory");
    const binding = await claim(session); await releaseActivity(owner, binding.activityId);
    if (tool === "codex_turn_start") return json({ started: true, session: metadata(session), backend: "active-codex", bootstrap: readMcpBootstrap() });
    const canary = session.nativeOwner.canary;
    return json({ ...metadata(session), source: "active Codex owner", tools: supported,
      capabilities: capabilities(contract).filter(c => supported.includes(c.name)),
      limits: { read_only: !canary, foreground_exec: true, background: false, patch: false, image: false,
        ...(canary ? { canary_only: true, host_sandbox: canary.hostSandbox, allowed_command: canaryCommand(canary.marker) } : {}),
        retries: "direct exec: same argv/cwd replays once per native turn; tool_call: explicit call_id" } });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "native_route_failed", backend: "active-codex", fp: session?.fp }, true); }
}
