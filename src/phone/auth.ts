// src/phone/auth.ts — "Nuestro SSH": quién puede hablarle a la API del celular y cómo se prueba.
//
// Tres capas, todas obligatorias:
//   1. Red: solo direcciones de Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48). WireGuard ya cifra
//      y autentica el equipo; la API no escucha en ninguna otra interfaz.
//   2. Dueño: `tailscale whois` de la IP de origen debe ser el MISMO usuario de Tailscale que esta
//      computadora, y (tras emparejar) el mismo nodo que emparejó esa llave.
//   3. Firma: cada petición va firmada (ECDSA P-256 / SHA-256, firma r||s de 64 bytes, la de CryptoKit)
//      sobre método, ruta, hora, nonce, hash del cuerpo y tipo de llave. ±60 s; un nonce no se repite.
//      Las acciones que dan permisos exigen la llave `approve`, que en el celular pide Face ID.
import { createHash } from "node:crypto";

export type KeyKind = "read" | "approve";

export const SIG_WINDOW_MS = 60_000;

/** Lo que se firma. Idéntico en la app (PhoneSigner.swift). */
export function canonicalString(method: string, pathWithQuery: string, ts: string, nonce: string, body: Uint8Array | string, key: KeyKind): string {
  const bodyHash = createHash("sha256").update(typeof body === "string" ? Buffer.from(body) : Buffer.from(body)).digest("hex");
  return `ISY1\n${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${nonce}\n${bodyHash}\n${key}`;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(b64: string): Promise<CryptoKey> {
  let p = keyCache.get(b64);
  if (!p) {
    p = crypto.subtle.importKey("raw", Buffer.from(b64, "base64"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    keyCache.set(b64, p);
    p.catch(() => keyCache.delete(b64));
  }
  return p;
}

/** ¿Es una llave pública P-256 válida (x963, 65 bytes)? */
export async function validPublicKey(b64: unknown): Promise<boolean> {
  if (typeof b64 !== "string" || b64.length > 200) return false;
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  try {
    await importKey(b64);
    return true;
  } catch {
    return false;
  }
}

export async function verifySignature(publicKeyB64: string, message: string, sigB64: string): Promise<boolean> {
  const sig = Buffer.from(String(sigB64 ?? ""), "base64");
  if (sig.length !== 64) return false;
  try {
    const key = await importKey(publicKeyB64);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, Buffer.from(message));
  } catch {
    return false;
  }
}

/** Nonces vistos dentro de la ventana: una petición capturada no se puede repetir. */
export class NonceCache {
  private seen = new Map<string, number>();
  constructor(private ttlMs = 2 * SIG_WINDOW_MS, private max = 20_000) {}
  /** true si el nonce es nuevo (y lo registra). */
  claim(key: string, now = Date.now()): boolean {
    if (this.seen.size > this.max / 2) for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    if (this.seen.size >= this.max) return false; // bajo ataque: cerrado
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > now) return false;
    this.seen.set(key, now + this.ttlMs);
    return true;
  }
}

// ─── Red y dueño ─────────────────────────────────────────────────────────────

/** ¿La IP es de Tailscale? (CGNAT 100.64.0.0/10 o el ULA fd7a:115c:a1e0::/48). */
export function isTailscaleAddress(ip: string): boolean {
  const v = ip.replace(/^::ffff:/, "");
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return a === 100 && b >= 64 && b <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(v);
}

export interface PeerIdentity {
  user_id: string;
  login: string;
  node: string;
  node_name: string;
  os: string;
}

export type WhoIs = (ip: string) => Promise<PeerIdentity | null>;
export type SelfUser = () => Promise<string | null>;

async function runTailscale(args: string[]): Promise<unknown> {
  const bin = Bun.which("tailscale");
  if (!bin) return null;
  const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => p.kill(), 10_000);
  try {
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    return JSON.parse(out);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const whoisCache = new Map<string, { at: number; id: PeerIdentity | null }>();

/** `tailscale whois --json <ip>`, cacheado 60 s. */
export const tailscaleWhois: WhoIs = async (ip) => {
  const hit = whoisCache.get(ip);
  if (hit && Date.now() - hit.at < 60_000) return hit.id;
  const d = (await runTailscale(["whois", "--json", ip])) as any;
  const id: PeerIdentity | null = d?.UserProfile?.ID && d?.Node?.StableID
    ? {
        user_id: String(d.UserProfile.ID),
        login: String(d.UserProfile.LoginName ?? ""),
        node: String(d.Node.StableID),
        node_name: String(d.Node.ComputedName ?? d.Node.Name ?? ""),
        os: String(d.Node.Hostinfo?.OS ?? ""),
      }
    : null;
  whoisCache.set(ip, { at: Date.now(), id });
  return id;
};

let selfCache: { at: number; id: string | null } | null = null;

/** Usuario de Tailscale de ESTA computadora (`tailscale status --json` > Self.UserID). */
export const tailscaleSelfUser: SelfUser = async () => {
  if (selfCache && Date.now() - selfCache.at < 300_000) return selfCache.id;
  const d = (await runTailscale(["status", "--json"])) as any;
  const id = d?.Self?.UserID !== undefined ? String(d.Self.UserID) : null;
  selfCache = { at: Date.now(), id };
  return id;
};

/** IPv4 de Tailscale de esta computadora (donde escucha la API). */
export async function tailscaleIPv4(): Promise<string | null> {
  const bin = Bun.which("tailscale");
  if (!bin) return null;
  // Con la máquina cargada `tailscale ip` puede tardar: 3 intentos de hasta 10 s.
  for (let i = 0; i < 3; i++) {
    const p = Bun.spawnSync([bin, "ip", "-4"], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    const ip = p.stdout.toString().trim().split("\n")[0] ?? "";
    if (p.exitCode === 0 && isTailscaleAddress(ip)) return ip;
  }
  return null;
}
