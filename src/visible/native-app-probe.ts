// Probe boundary for the actual desktop writer. No app-server impersonation,
// auth copying, global configuration edits, or thread adoption.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const uuid = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
export class NativeAppTurnGate {
  owner: { threadId: string; turnId: string } | null = null;
  private phase: "idle" | "pending" | "result" | "complete" = "idle";
  private callId?: string;
  constructor(private options: { threadId: string; model: string; marker: string }) {
    if (!uuid(options.threadId) || !options.marker.trim()) throw Error("invalid_native_app_probe_identity");
  }
  setNativeCall(callId: string) {
    if (this.phase !== "pending" || this.callId || !callId) throw Error("native_app_call_identity_already_set");
    this.callId = callId;
  }
  accept(body: any): { kind: "start" | "result"; output?: any } {
    if (this.phase === "complete") throw Error("native_app_probe_complete");
    if (body?.model !== this.options.model) throw Error("native_app_model_mismatch");
    const meta = body?.client_metadata;
    if (meta?.thread_id !== this.options.threadId) throw Error("native_app_thread_mismatch");
    if (!uuid(meta?.turn_id)) throw Error("native_app_turn_identity_missing");
    if (this.owner && this.owner.turnId !== meta.turn_id) throw Error("native_app_turn_mismatch");
    const items = Array.isArray(body.input) ? body.input : [];
    const lastUser = items.findLast((item: any) => item.type === "message" && item.role === "user");
    const userText = Array.isArray(lastUser?.content) ? lastUser.content.map((b: any) => typeof b.text === "string" ? b.text : "").join("") : "";
    const literal = userText.trim();
    if (![this.options.marker, "`" + this.options.marker + "`", "**" + this.options.marker + "**"].includes(literal)) throw Error("native_app_marker_mismatch");
    if (this.phase === "idle") {
      this.owner = { threadId: meta.thread_id, turnId: meta.turn_id }; this.phase = "pending"; return { kind: "start" };
    }
    if (this.phase !== "pending" || !this.callId) throw Error("native_app_turn_pending_no_resubmission");
    const results = items.filter((item: any) => item.type === "custom_tool_call_output" && item.call_id === this.callId);
    if (results.length !== 1) throw Error("native_app_result_identity_missing_or_duplicate");
    this.phase = "result"; return { kind: "result", output: results[0] };
  }
  complete() { if (this.phase !== "result") throw Error("native_app_result_pending"); this.phase = "complete"; }
}
export function readOwnedAppProbeProfile(options: { root: string; configSha256: string; model: string; port: number }) {
  if (!isAbsolute(options.root) || !/^[a-f0-9]{64}$/.test(options.configSha256) || !Number.isInteger(options.port)) throw Error("invalid_app_profile_grant");
  const root = realpathSync(options.root), codexHome = join(root, "codex"), userData = join(root, "electron");
  if (!statSync(codexHome).isDirectory() || !statSync(userData).isDirectory()) throw Error("native_app_profile_missing");
  const text = readFileSync(join(codexHome, "config.toml"), "utf8");
  if (createHash("sha256").update(text).digest("hex") !== options.configSha256) throw Error("native_app_profile_changed");
  const config = Bun.TOML.parse(text) as any, provider = config.model_providers?.[config.model_provider];
  if (config.model !== options.model || provider?.base_url !== `http://127.0.0.1:${options.port}/v1` || provider.requires_openai_auth !== false) throw Error(
    "native_app_profile_endpoint_mismatch");
  if (config.model_catalog_json && (!isAbsolute(config.model_catalog_json) || !existsSync(config.model_catalog_json) || !statSync(config.model_catalog_json).
    isFile())) throw Error("native_app_catalog_missing");
  return { root, codexHome, userData, configSha256: options.configSha256 };
}

// Own the transport lifetime separately from the asynchronous native work.
// Cancellation is terminal: no late tool call may be written to this response.
export function appProbeStream(options: {
  signal?: AbortSignal;
  heartbeatMs?: number;
  work: (emit: (event: unknown) => boolean) => Promise<void>;
  onDisconnect: () => void;
  onError: (error: unknown) => void;
}): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    options.signal?.removeEventListener("abort", abort);
  };
  const disconnect = () => {
    if (closed) return;
    closed = true; cleanup(); options.onDisconnect();
  };
  const abort = () => {
    if (closed) return;
    disconnect();
    try { controller.error(Error("native_app_disconnected")); } catch {}
  };
  const enqueue = (bytes: Uint8Array): boolean => {
    if (closed) return false;
    try { controller.enqueue(bytes); return true; }
    catch { disconnect(); return false; }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(target) {
      controller = target;
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      heartbeat = setInterval(() => enqueue(encoder.encode(": waiting for actual ISyMCP call\n\n")), options.heartbeatMs ?? 15000);
      void (async () => {
        try {
          await options.work(event => enqueue(encoder.encode(`event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`)));
          if (closed) return;
          enqueue(encoder.encode("data: [DONE]\n\n"));
          if (closed) return;
          closed = true; cleanup(); controller.close();
        } catch (error) {
          if (closed) return;
          closed = true; cleanup(); controller.error(error); options.onError(error);
        }
      })();
    },
    cancel() { disconnect(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
