// Owner-only IPC coordinator. It queues calls; it NEVER executes tool code.
// Protocol 5 keeps compatibility with the already-probed native gateway.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { createServer, type Socket } from "node:net";

interface Call { callId: string; wireName: string; freeform: true; input: string; delivered: boolean; resolve: (r: unknown) => void; reject: (e: Error) => void }
interface Channel {
  environment: any; expires: number; revision: number; committed: boolean;
  activities: Set<string>; bindings: Set<string>; calls: Map<string, Call>;
  next?: (calls: unknown) => void;
}
const key = (prefix: string) => prefix + randomBytes(24).toString("base64url");
export async function createActiveBroker(socketPath: string) {
  if (existsSync(socketPath)) throw Error("native_broker_path_exists_no_replacement");
  const channels = new Map<string, Channel>(), bindings = new Map<string, { channel: Channel; activityId: string }>(), clients = new Set<Socket>();
  const get = (token: unknown) => {
    const c = typeof token === "string" ? channels.get(token) : undefined;
    if (!c || c.expires <= Date.now() || c.committed) throw Error("native_owner_not_active"); return c;
  };
  const next = (c: Channel) => {
    const calls = [...c.calls.values()].filter(call => !call.delivered);
    for (const call of calls) call.delivered = true;
    return { requests: calls.map(({ callId, wireName, freeform, input }) => ({ callId, wireName, freeform, input })) };
  };
  const revoke = (token: string) => {
    const c = channels.get(token); if (!c) return;
    for (const call of c.calls.values()) call.reject(Error("native_owner_revoked"));
    c.next?.({ requests: [] });
    for (const id of c.bindings) bindings.delete(id); channels.delete(token);
  };
  async function dispatch(r: any): Promise<unknown> {
    if (r.method === "owner_status") return { protocolVersion: 5, acceptingExternalOwners: true };
    if (r.method === "owner_register") {
      if (!Number.isInteger(r.ttlMs) || r.ttlMs < 1000 || r.ttlMs > 1200000 ||
        !r.environment || typeof r.environment.cwd !== "string" || r.environment.sandboxPolicy?.type !== "readOnly" ||
        !Array.isArray(r.environment.writableRoots) || r.environment.writableRoots.length ||
        !Array.isArray(r.environment.tools) || r.environment.tools.length !== 1 || r.environment.tools[0].name !== "exec" || r.environment.tools[0].freeform !== true) throw Error("invalid_native_owner_environment");
      if (channels.size >= 32) throw Error("native_owner_limit");
      const token = key("turn_");
      channels.set(token, { environment: r.environment, expires: Date.now() + r.ttlMs, revision: 0, committed: false,
        activities: new Set(), bindings: new Set(), calls: new Map() }); return { token };
    }
    if (r.method === "owner_revoke") { revoke(r.token); return { revoked: true }; }
    if (r.method === "claim") {
      const c = get(r.token);
      if (r.contract !== "native" || typeof r.activityId !== "string" || !r.activityId.startsWith("activity_")) throw Error("invalid_native_claim");
      const bindingId = key("binding_"); c.activities.add(r.activityId); c.revision++;
      c.bindings.add(bindingId); bindings.set(bindingId, { channel: c, activityId: r.activityId });
      return { bindingId, activityId: r.activityId, environment: c.environment };
    }
    if (r.method === "invoke") {
      const binding = bindings.get(r.bindingId), c = binding?.channel;
      if (!c || c.committed || c.expires <= Date.now() || !c.activities.has(binding!.activityId)) throw Error("native_binding_inactive");
      if (r.wireName !== "exec" || r.freeform !== true || typeof r.input !== "string" || r.input.length > 65536) throw Error("unsupported_native_invocation");
      if (c.calls.size) throw Error("native_call_already_pending");
      c.revision++;
      return new Promise((resolve, reject) => {
        const callId = key("call_"); c.calls.set(callId, { callId, wireName: "exec", freeform: true, input: r.input, delivered: false, resolve, reject });
        if (c.next) { const wake = c.next; c.next = undefined; wake(next(c)); }
      });
    }
    const c = get(r.token);
    if (r.method === "owner_next") {
      if ([...c.calls.values()].some(call => !call.delivered)) return next(c);
      if (c.next) throw Error("native_owner_already_waiting");
      return new Promise(resolve => { c.next = resolve; });
    }
    if (r.method === "owner_complete") {
      const call = c.calls.get(r.callId);
      if (!call || !call.delivered || !r.toolResult || !Array.isArray(r.toolResult.content)) throw Error("native_result_call_mismatch");
      c.calls.delete(r.callId); c.revision++; call.resolve(r.toolResult); return { completed: true };
    }
    if (r.method === "activity_complete") {
      if (c.activities.delete(r.activityId)) c.revision++;
      for (const id of c.bindings) if (bindings.get(id)?.activityId === r.activityId) {
        bindings.delete(id); c.bindings.delete(id);
      }
      return { completed: true };
    }
    if (r.method === "owner_completion_fence_begin") return c.calls.size || c.activities.size ? null : c.revision;
    if (r.method === "owner_completion_fence_commit") {
      if (r.revision !== c.revision || c.calls.size || c.activities.size) return { committed: false };
      c.committed = true; for (const id of c.bindings) bindings.delete(id); c.bindings.clear(); return { committed: true };
    }
    throw Error("unknown_native_owner_operation");
  }
  const server = createServer(socket => {
    clients.add(socket); let raw = "", submitted = false;
    socket.on("close", () => clients.delete(socket)); socket.on("error", () => {});
    socket.on("data", chunk => {
      if (submitted) return; raw += chunk;
      if (Buffer.byteLength(raw) > 128 * 1024) { socket.destroy(); return; }
      if (!raw.includes("\n")) return; submitted = true;
      let r: any; try { r = JSON.parse(raw.slice(0, raw.indexOf("\n"))); } catch { socket.end(); return; }
      if (typeof r.id !== "string") { socket.end(); return; }
      void dispatch(r).then(result => socket.end(JSON.stringify({ id: r.id, result })), e => socket.end(JSON.stringify({ id: r.id, error: e.message })));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  const expiry = setInterval(() => { for (const [token, c] of channels) if (c.expires <= Date.now()) revoke(token); }, 1000);
  expiry.unref();
  return { close: async () => {
    clearInterval(expiry); for (const token of channels.keys()) revoke(token);
    for (const socket of clients) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
