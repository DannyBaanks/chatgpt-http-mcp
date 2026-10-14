import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BoundBrowserSource, ClientKind, HostContract, NativeOutput } from "./contracts";

const execFileAsync = promisify(execFile);

interface Lease {
  owner: string;
  token: string;
}

/** Process-local guard. Cross-process ownership is provided by the owning Codex host. */
export class NativeWriterLease {
  private readonly leases = new Map<string, Lease>();

  async acquire(threadId: string, owner: string): Promise<string> {
    if (!threadId.trim() || !owner.trim()) throw new Error("native_writer_identity_invalid");
    const current = this.leases.get(threadId);
    if (current) {
      if (current.owner === owner) return current.token;
      throw new Error("native_writer_conflict");
    }
    const token = randomUUID();
    this.leases.set(threadId, { owner, token });
    return token;
  }

  async owner(threadId: string): Promise<string | undefined> {
    return this.leases.get(threadId)?.owner;
  }

  async release(threadId: string, token: string): Promise<void> {
    const current = this.leases.get(threadId);
    if (current?.token === token) this.leases.delete(threadId);
  }
}

export function correlateNativeToolResult(
  call: Record<string, unknown>,
  result: NativeOutput,
): { callId: string; wireName: string; output: unknown } {
  const callId = typeof call.call_id === "string" ? call.call_id : "";
  const wireName = typeof call.name === "string" ? call.name : "";
  const isFunction = call.type === "function_call" && result.type === "function_call_output";
  const isCustom = call.type === "custom_tool_call" && result.type === "custom_tool_call_output";
  if (!callId || !wireName || (!isFunction && !isCustom) || result.call_id !== callId || !("output" in result)) {
    throw new Error("native_tool_result_mismatch");
  }
  return { callId, wireName, output: result.output };
}

export function requireBoundBrowserSource(source: {
  url?: unknown;
  messageId?: unknown;
}): BoundBrowserSource {
  if (typeof source.url !== "string" || typeof source.messageId !== "string" || !source.messageId.trim()) {
    throw new Error("browser_source_binding_required");
  }
  let parsed: URL;
  try {
    parsed = new URL(source.url);
  } catch {
    throw new Error("browser_source_binding_required");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com" || !/^\/c\/[^/]+\/?$/.test(parsed.pathname)) {
    throw new Error("browser_source_binding_invalid");
  }
  return { url: `https://chatgpt.com${parsed.pathname.replace(/\/$/, "")}`, messageId: source.messageId };
}

/**
 * Reports installed protocol support conservatively. A detected binary alone
 * never sets `supported`: an owned live writer still needs a canary receipt.
 */
export async function inspectHost(client: ClientKind): Promise<HostContract> {
  if (client === "app") {
    return {
      client,
      version: "unknown",
      evidenceSha256: "",
      supported: false,
      blocker: "desktop_app_live_ownership_probe_required",
    };
  }
  try {
    const [{ stdout: version }, { stdout: help }] = await Promise.all([
      execFileAsync("codex", ["--version"], { timeout: 3_000, maxBuffer: 64 * 1024 }),
      execFileAsync("codex", ["app-server", "--help"], { timeout: 3_000, maxBuffer: 128 * 1024 }),
    ]);
    const cleanVersion = version.trim();
    const protocolPresent = help.includes("generate-ts") && help.includes("--listen");
    return {
      client,
      version: cleanVersion,
      evidenceSha256: "",
      supported: false,
      blocker: protocolPresent ? "live_single_writer_canary_required" : "installed_app_server_protocol_unavailable",
    };
  } catch {
    return {
      client,
      version: "unknown",
      evidenceSha256: "",
      supported: false,
      blocker: "codex_cli_unavailable",
    };
  }
}
