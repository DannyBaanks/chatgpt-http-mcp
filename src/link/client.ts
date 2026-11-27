// src/link/client.ts — Cliente HTTP sellado + pairing SAS v2 para ISyMCP Link (`munder-link@1`).
import crypto from "node:crypto";
import http from "node:http";
import {
  b64u,
  DEFAULT_PORT,
  LinkError,
  MAX_PEER_ADDRESSES,
  officeIdOf,
  open,
  PROTOCOL,
  publicCard,
  sas,
  seal,
  type LinkPeer,
  type SealedEnvelope,
} from "./crypto";
import {
  appendReceipt,
  defaultLinkDir,
  findPeer,
  loadIdentity,
  loadPeers,
  loadPending,
  payloadFingerprint,
  rememberOrigin,
  savePeers,
  savePending,
} from "./store";

export function hostPort(address: string): string {
  const s = String(address);
  if (/^\[.*\]:\d+$/.test(s) || /^[^:]+:\d+$/.test(s)) return s;
  return s.includes(":") && !s.startsWith("[") ? `[${s}]:${DEFAULT_PORT}` : `${s}:${DEFAULT_PORT}`;
}

function httpJson(
  method: string,
  url: string,
  body?: unknown,
  timeoutMs = 4000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      url,
      {
        method,
        timeout: timeoutMs,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
            resolve({ status: res.statusCode ?? 500, body: parsed });
          } catch {
            reject(new LinkError("bad_reply", "respuesta no JSON", 502));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new LinkError("timeout", "sin respuesta", 504)));
    req.on("error", (e: NodeJS.ErrnoException) =>
      reject(e instanceof LinkError ? e : new LinkError("unreachable", `no contesta (${e.code || e.message})`, 503)),
    );
    if (data) req.write(data);
    req.end();
  });
}

export async function hello(address: string, timeoutMs = 2500): Promise<Record<string, unknown>> {
  const r = await httpJson("GET", `http://${hostPort(address)}/link/v1/hello`, undefined, timeoutMs);
  if (r.status !== 200 || r.body.protocol !== PROTOCOL) {
    throw new LinkError("not_munder", "eso no es una oficina ISyMCP/Munder Link", 502);
  }
  return r.body;
}

export async function requestPair(
  address: string,
  opts: { dir?: string; port?: number } = {},
): Promise<{ peer: Omit<LinkPeer, "paired_at">; code: string }> {
  const dir = opts.dir ?? defaultLinkDir();
  const port = opts.port ?? DEFAULT_PORT;
  const identity = loadIdentity(dir);
  const nonce = b64u(crypto.randomBytes(16));
  const r = await httpJson("POST", `http://${hostPort(address)}/link/v1/pair`, {
    ...publicCard(identity),
    nonce,
    port,
  });
  if (r.status !== 200) {
    throw new LinkError(String(r.body.code || "pair_failed"), String(r.body.error || "el emparejamiento falló"), r.status);
  }
  const b = r.body;
  if (typeof b.sign_pub !== "string" || officeIdOf(b.sign_pub) !== b.office_id) {
    throw new LinkError("bad_identity", "la otra oficina mandó llaves que no cuadran", 502);
  }
  if (typeof b.box_pub !== "string" || typeof b.nonce !== "string") {
    throw new LinkError("bad_identity", "la otra oficina no mandó su llave de cifrado", 502);
  }
  return {
    peer: {
      office_id: String(b.office_id),
      name: String(b.name || "desconocida"),
      sign_pub: b.sign_pub,
      box_pub: b.box_pub,
      addresses: [hostPort(address)],
      authority: { office: true, compute: false },
    },
    code: sas(identity.sign.x, b.sign_pub, nonce, b.nonce, identity.box.x, b.box_pub),
  };
}

export function trustPeer(peer: Omit<LinkPeer, "paired_at"> & { paired_at?: string }, dir = defaultLinkDir()): LinkPeer {
  const peers = loadPeers(dir);
  const prev = peers[peer.office_id];
  const addresses = [...new Set([...(peer.addresses || []), ...(prev?.addresses || [])])].slice(0, MAX_PEER_ADDRESSES);
  peers[peer.office_id] = {
    office_id: peer.office_id,
    name: peer.name,
    sign_pub: peer.sign_pub,
    box_pub: peer.box_pub,
    addresses,
    paired_at: prev?.paired_at || peer.paired_at || new Date().toISOString(),
    authority: prev?.authority ?? { office: true, compute: false },
  };
  savePeers(peers, dir);
  return peers[peer.office_id]!;
}

export function acceptPending(code: string, dir = defaultLinkDir()): LinkPeer | null {
  const pending = loadPending(dir);
  const hit = Object.values(pending).find((p) => p.code === String(code).trim());
  if (!hit) return null;
  delete pending[hit.office_id];
  savePending(pending, dir);
  return trustPeer(hit, dir);
}

export function forgetPeer(query: string, dir = defaultLinkDir()): LinkPeer | null {
  const peers = loadPeers(dir);
  const p = findPeer(query, peers);
  if (!p) return null;
  delete peers[p.office_id];
  savePeers(peers, dir);
  return p;
}

const NON_RETRYABLE_CODES = new Set([
  "unknown_peer",
  "bad_signature",
  "no_task",
  "unknown_origin",
  "origin_conflict",
  "bad_args",
  "bad_op",
  "no_hive",
  "compute_denied",
  "no_job",
  "not_found",
]);

export async function call<T = unknown>(
  query: string,
  op: string,
  args: Record<string, unknown> = {},
  opts: { dir?: string; timeoutMs?: number; budgetMs?: number } = {},
): Promise<{ peer: LinkPeer; address: string; latency_ms: number; result: T }> {
  const dir = opts.dir ?? defaultLinkDir();
  const timeoutMs = opts.timeoutMs ?? 6000;
  const identity = loadIdentity(dir);
  const peers = loadPeers(dir);
  const peer = findPeer(query, peers);
  if (!peer) {
    throw new LinkError("unknown_peer", `no hay una oficina emparejada que se llame «${query}»`, 404);
  }
  const total = Math.max(timeoutMs, opts.budgetMs ?? timeoutMs * 2);
  const startedAll = Date.now();
  let lastErr: unknown = null;

  for (const address of (peer.addresses || []).slice(0, MAX_PEER_ADDRESSES)) {
    const left = total - (Date.now() - startedAll);
    if (left <= 0) break;
    const started = Date.now();
    try {
      const sent = seal(identity, peer, { op, args });
      const r = await httpJson("POST", `http://${address}/link/v1/call`, sent, Math.min(timeoutMs, left));
      if (r.status !== 200) {
        throw new LinkError(String(r.body.code || "call_failed"), String(r.body.error || `HTTP ${r.status}`), r.status);
      }
      const { payload } = open<{ ok: boolean; result: T; re?: string }>(
        identity,
        { [peer.office_id]: peer },
        r.body as unknown as SealedEnvelope,
        new Map(),
      );
      if (payload.re !== undefined && payload.re !== sent.nonce) {
        throw new LinkError("bad_reply", "la respuesta no corresponde a esta llamada", 502);
      }
      if (!payload.ok) {
        throw new LinkError("remote_error", "la otra oficina respondió con error", 502);
      }
      if (peer.addresses[0] !== address) {
        peer.addresses = [address, ...peer.addresses.filter((a) => a !== address)];
        savePeers({ ...peers, [peer.office_id]: peer }, dir);
      }
      return { peer, address, latency_ms: Date.now() - started, result: payload.result };
    } catch (e) {
      lastErr = e;
      if (e instanceof LinkError && NON_RETRYABLE_CODES.has(e.code)) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new LinkError("no_address", "esa oficina no tiene direcciones conocidas", 503);
}

export async function delegate(
  query: string,
  compose: string,
  opts: { title?: string; priority?: number; dir?: string } = {},
) {
  const dir = opts.dir ?? defaultLinkDir();
  const originRef = `link-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  const r = await call<{ task_id: string; duplicate?: boolean }>(
    query,
    "submit",
    { compose, title: opts.title, priority: opts.priority, origin_ref: originRef },
    { dir },
  );
  rememberOrigin({
    dir,
    toOffice: r.peer.office_id,
    toName: r.peer.name,
    originRef,
    taskId: r.result.task_id,
    payloadHash: payloadFingerprint({ compose, title: opts.title, priority: opts.priority }),
  });
  appendReceipt(dir, {
    event: "delegated",
    to: r.peer.office_id,
    to_name: r.peer.name,
    origin_ref: originRef,
    remote_task_id: r.result.task_id,
    duplicate: !!r.result.duplicate,
    compose: compose.slice(0, 200),
  });
  return { ...r, origin_ref: originRef };
}

export async function reply(
  query: string,
  originRef: string,
  opts: { text?: string; result?: string; status?: string; dir?: string } = {},
) {
  if (typeof originRef !== "string" || !originRef.trim()) {
    throw new LinkError("bad_args", "falta la origin_ref de la tarea");
  }
  return call(
    query,
    "reply",
    { origin_ref: originRef.trim(), text: opts.text, result: opts.result, status: opts.status },
    { dir: opts.dir },
  );
}
