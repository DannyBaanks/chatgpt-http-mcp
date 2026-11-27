// src/link/crypto.ts — Primitivas criptográficas wire-compatible con `munder-link@1`.
// Ed25519 (firma) + X25519 → HKDF-SHA256 → AES-256-GCM (cifrado) + SAS v2 de 6 dígitos.
import crypto from "node:crypto";
import os from "node:os";

export const PROTOCOL = "munder-link@1";
export const MAX_SKEW_MS = 120_000;
export const NONCE_TTL_MS = 10 * 60_000;
export const PENDING_TTL_MS = 10 * 60_000;
export const MAX_PENDING = 5;
export const MAX_BODY = 256 * 1024;
export const PAIR_RATE = 5;
export const PAIR_WINDOW_MS = 10 * 60_000;
export const MAX_DISCOVERY_ATTEMPTS = 4;
export const MAX_DISCOVERY_TARGETS = 32;
export const MAX_PEER_ADDRESSES = 8;
export const ORIGIN_TTL_MS = 30 * 24 * 60 * 60_000;
export const MAX_ORIGINS = 2000;

export function configuredPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : fallback;
}

export const DEFAULT_PORT = configuredPort("ISYMCP_LINK_PORT", configuredPort("MUNDER_LINK_PORT", 47831));
export const DISCOVERY_PORT = configuredPort("ISYMCP_LINK_DISCOVERY_PORT", configuredPort("MUNDER_LINK_DISCOVERY_PORT", 47832));
export const PROBE = "MUNDER-LINK?v1";

export class LinkError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface LinkIdentity {
  protocol: string;
  name: string;
  office_id: string;
  sign: { x: string; d: string };
  box: { x: string; d: string };
  created_at: string;
}

export interface PeerAuthority {
  office: boolean;
  compute: boolean;
}

export interface LinkPeer {
  office_id: string;
  name: string;
  sign_pub: string;
  box_pub: string;
  addresses: string[];
  paired_at: string;
  authority?: Partial<PeerAuthority>;
}

export interface SealedEnvelope {
  v: 1;
  from: string;
  to: string;
  ts: number;
  nonce: string;
  iv: string;
  ct: string;
  sig: string;
}

export const b64u = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString("base64url");
export const fromB64u = (s: string): Buffer => Buffer.from(String(s), "base64url");

export function officeIdOf(signPub: string): string {
  return crypto.createHash("sha256").update(fromB64u(signPub)).digest("hex").slice(0, 16);
}

export function prettyFingerprint(officeId: string): string {
  return officeId.match(/.{4}/g)?.join(" ") ?? officeId;
}

export function defaultOfficeName(): string {
  return `isymcp-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 24)}`;
}

export function generateIdentity(name?: string | null): LinkIdentity {
  const sign = crypto.generateKeyPairSync("ed25519");
  const box = crypto.generateKeyPairSync("x25519");
  const signJwk = sign.privateKey.export({ format: "jwk" }) as { x: string; d: string };
  const boxJwk = box.privateKey.export({ format: "jwk" }) as { x: string; d: string };
  return {
    protocol: PROTOCOL,
    name: name || defaultOfficeName(),
    office_id: officeIdOf(signJwk.x),
    sign: { x: signJwk.x, d: signJwk.d },
    box: { x: boxJwk.x, d: boxJwk.d },
    created_at: new Date().toISOString(),
  };
}

export function publicCard(identity: LinkIdentity, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: PROTOCOL,
    office_id: identity.office_id,
    name: identity.name,
    sign_pub: identity.sign.x,
    box_pub: identity.box.x,
    ...extra,
  };
}

const signPriv = (id: LinkIdentity) =>
  crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: id.sign.x, d: id.sign.d }, format: "jwk" });
const signPubKey = (x: string) =>
  crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
const boxPriv = (id: LinkIdentity) =>
  crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: id.box.x, d: id.box.d }, format: "jwk" });
const boxPubKey = (x: string) =>
  crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });

export function sas(
  signPubA: string,
  signPubB: string,
  nonceA: string,
  nonceB: string,
  boxPubA: string,
  boxPubB: string,
): string {
  if (typeof boxPubA !== "string" || typeof boxPubB !== "string") {
    throw new LinkError("bad_args", "faltan llaves de cifrado");
  }
  const [k1, k2] = [`${signPubA}.${boxPubA}`, `${signPubB}.${boxPubB}`].sort();
  const [n1, n2] = [nonceA, nonceB].sort();
  const h = crypto.createHash("sha256").update(`${PROTOCOL}|sas@2|${k1}|${k2}|${n1}|${n2}`).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function isPrivateV4(address: string): boolean {
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(address));
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function sharedKey(identity: LinkIdentity, peerBoxPub: string, peerOfficeId: string): Buffer {
  const secret = crypto.diffieHellman({ privateKey: boxPriv(identity), publicKey: boxPubKey(peerBoxPub) });
  const salt = [identity.office_id, peerOfficeId].sort().join("|");
  return Buffer.from(crypto.hkdfSync("sha256", secret, salt, `${PROTOCOL} seal`, 32));
}

const signedText = (e: Omit<SealedEnvelope, "sig">): string =>
  [e.v, e.from, e.to, e.ts, e.nonce, e.iv, e.ct].join("|");

export function seal(
  identity: LinkIdentity,
  peer: Pick<LinkPeer, "office_id" | "box_pub">,
  payload: unknown,
  now = Date.now(),
): SealedEnvelope {
  const key = sharedKey(identity, peer.box_pub, peer.office_id);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${identity.office_id}>${peer.office_id}`));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const body = {
    v: 1 as const,
    from: identity.office_id,
    to: peer.office_id,
    ts: now,
    nonce: b64u(crypto.randomBytes(16)),
    iv: b64u(iv),
    ct: b64u(ct),
  };
  const sig = b64u(crypto.sign(null, Buffer.from(signedText(body)), signPriv(identity)));
  return { ...body, sig };
}

export function open<T = Record<string, unknown>>(
  identity: LinkIdentity,
  peers: Record<string, LinkPeer>,
  env: SealedEnvelope,
  seen: Map<string, number>,
  now = Date.now(),
): { peer: LinkPeer; payload: T } {
  if (!env || env.v !== 1 || typeof env.from !== "string") {
    throw new LinkError("bad_envelope", "sobre inválido");
  }
  if (env.to !== identity.office_id) {
    throw new LinkError("wrong_office", "el sobre es para otra oficina", 403);
  }
  const peer = peers[env.from];
  if (!peer) {
    throw new LinkError("unknown_peer", "oficina no emparejada", 401);
  }
  const ok = crypto.verify(null, Buffer.from(signedText(env)), signPubKey(peer.sign_pub), fromB64u(env.sig || ""));
  if (!ok) {
    throw new LinkError("bad_signature", "firma inválida", 401);
  }
  if (Math.abs(now - Number(env.ts)) > MAX_SKEW_MS) {
    throw new LinkError("stale", "sobre fuera de tiempo (revisa la hora de ambas máquinas)", 401);
  }
  for (const [n, exp] of seen) if (exp < now) seen.delete(n);
  if (seen.has(env.nonce)) {
    throw new LinkError("replay", "sobre repetido", 401);
  }
  seen.set(env.nonce, now + NONCE_TTL_MS);

  const key = sharedKey(identity, peer.box_pub, peer.office_id);
  const raw = fromB64u(env.ct);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, fromB64u(env.iv));
  decipher.setAAD(Buffer.from(`${env.from}>${env.to}`));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  let text: string;
  try {
    text = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    throw new LinkError("bad_seal", "no se pudo descifrar", 401);
  }
  return { peer, payload: JSON.parse(text) as T };
}

export function hostCapacity(): {
  ram_total_gb: number;
  ram_free_gb: number;
  cpus: number;
  load1: number;
  platform: NodeJS.Platform;
} {
  const gb = (n: number) => Math.round((n / 1024 ** 3) * 10) / 10;
  return {
    ram_total_gb: gb(os.totalmem()),
    ram_free_gb: gb(os.freemem()),
    cpus: os.cpus().length,
    load1: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
    platform: process.platform,
  };
}
