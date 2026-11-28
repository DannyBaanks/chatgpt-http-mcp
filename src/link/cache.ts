// src/link/cache.ts — Caché compartida direccionada por contenido (sha256) para ISyMCP Link.
//
// Almacén:  <root>/blobs/sha256/<aa>/<hash>   + <root>/index.json (clave lógica → hash)
// Escritura atómica (tmp + rename) y verificación del hash antes de publicar un blob.
// Los peers leen blobs por `GET /cache/blob/<hash>?t=<ticket>` con un ticket de un solo uso
// (TTL corto, ligado al office_id que lo pidió) que emite el op sellado `cache_ticket`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bridgeHome } from "../codex-sessions";

export const HASH_RE = /^[0-9a-f]{64}$/;
export const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 256;

export interface CacheEntry {
  key: string;
  sha256: string;
  size: number;
  added_at: string;
  last_used_at: string;
  source?: string;
}

export interface CacheIndex {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export function defaultCacheDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.ISYMCP_CACHE_DIR;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  return path.join(bridgeHome(env), "cache");
}

/** Clave lógica estable: `hf:<repo>@<rev>/<file>` tal cual; URLs sin fragmento, host en minúsculas. */
export function normalizeKey(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("clave vacía");
  if (s.startsWith("hf:")) {
    const m = /^hf:([^@\s]+\/[^@\s]+)(?:@([^/\s]+))?\/(.+)$/.exec(s);
    if (!m) throw new Error(`clave hf inválida: ${s} (usa hf:<org>/<repo>[@rev]/<archivo>)`);
    return `hf:${m[1]}@${m[2] ?? "main"}/${m[3]}`;
  }
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    u.hash = "";
    return u.toString();
  }
  if (s.startsWith("key:")) return s;
  return `key:${s}`;
}

/** URL de internet para una clave (null si la clave no es descargable). */
export function keyToUrl(key: string): string | null {
  if (key.startsWith("hf:")) {
    const m = /^hf:([^@]+)@([^/]+)\/(.+)$/.exec(key);
    if (!m) return null;
    const file = m[3]!.split("/").map(encodeURIComponent).join("/");
    return `https://huggingface.co/${m[1]}/resolve/${encodeURIComponent(m[2]!)}/${file}`;
  }
  if (/^https?:\/\//.test(key)) return key;
  return null;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

export class CacheStore {
  readonly root: string;

  constructor(root = defaultCacheDir()) {
    this.root = root;
  }

  private get indexPath(): string {
    return path.join(this.root, "index.json");
  }

  tmpDir(): string {
    const d = path.join(this.root, "tmp");
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  blobPath(hash: string): string {
    if (!HASH_RE.test(hash)) throw new Error(`hash inválido: ${hash}`);
    return path.join(this.root, "blobs", "sha256", hash.slice(0, 2), hash);
  }

  hasBlob(hash: string): boolean {
    return HASH_RE.test(hash) && fs.existsSync(this.blobPath(hash));
  }

  blobSize(hash: string): number | null {
    try {
      return fs.statSync(this.blobPath(hash)).size;
    } catch {
      return null;
    }
  }

  loadIndex(): CacheIndex {
    try {
      const j = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as CacheIndex;
      if (j && j.version === 1 && j.entries && typeof j.entries === "object") return j;
    } catch {
      /* vacío o corrupto: se reconstruye */
    }
    return { version: 1, entries: {} };
  }

  private saveIndex(idx: CacheIndex): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = `${this.indexPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.indexPath);
  }

  /** Busca por clave; solo devuelve entradas cuyo blob siga en disco. */
  lookup(key: string): CacheEntry | null {
    const e = this.loadIndex().entries[normalizeKey(key)];
    return e && this.hasBlob(e.sha256) ? e : null;
  }

  touch(key: string): void {
    const idx = this.loadIndex();
    const e = idx.entries[normalizeKey(key)];
    if (!e) return;
    e.last_used_at = new Date().toISOString();
    this.saveIndex(idx);
  }

  /**
   * Publica un archivo temporal ya escrito como blob. Recalcula sha256; si se pasa
   * `expected` y no coincide, borra el temporal y lanza. Devuelve el hash.
   */
  async adoptTemp(tmpFile: string, opts: { expected?: string; key?: string; source?: string } = {}): Promise<CacheEntry | { sha256: string; size: number }> {
    const hash = await sha256File(tmpFile);
    if (opts.expected && opts.expected !== hash) {
      fs.rmSync(tmpFile, { force: true });
      throw new Error(`hash no coincide: esperado ${opts.expected}, recibido ${hash}`);
    }
    const size = fs.statSync(tmpFile).size;
    const dest = this.blobPath(hash);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    if (fs.existsSync(dest)) fs.rmSync(tmpFile, { force: true });
    else fs.renameSync(tmpFile, dest);
    if (opts.key) return this.record(opts.key, hash, size, opts.source);
    return { sha256: hash, size };
  }

  record(key: string, hash: string, size: number, source?: string): CacheEntry {
    const k = normalizeKey(key);
    const now = new Date().toISOString();
    const idx = this.loadIndex();
    const prev = idx.entries[k];
    const entry: CacheEntry = {
      key: k,
      sha256: hash,
      size,
      added_at: prev?.sha256 === hash ? prev.added_at : now,
      last_used_at: now,
      ...(source ? { source } : prev?.source ? { source: prev.source } : {}),
    };
    idx.entries[k] = entry;
    this.saveIndex(idx);
    return entry;
  }

  /** Copia un archivo local al almacén (sin tocar el original). */
  async put(file: string, key?: string): Promise<CacheEntry> {
    const tmp = path.join(this.tmpDir(), `put-${crypto.randomBytes(6).toString("hex")}`);
    fs.copyFileSync(file, tmp);
    const k = key ?? `key:${path.basename(file)}`;
    return (await this.adoptTemp(tmp, { key: k, source: "put" })) as CacheEntry;
  }

  ls(): CacheEntry[] {
    return Object.values(this.loadIndex().entries)
      .filter((e) => this.hasBlob(e.sha256))
      .sort((a, b) => b.last_used_at.localeCompare(a.last_used_at));
  }

  /** Respuesta a `cache_has`: qué claves/hashes tengo (con tamaño). */
  has(query: { keys?: unknown; hashes?: unknown }): {
    keys: Record<string, { sha256: string; size: number }>;
    hashes: Record<string, number>;
  } {
    const keys: Record<string, { sha256: string; size: number }> = {};
    const hashes: Record<string, number> = {};
    const idx = this.loadIndex();
    for (const raw of Array.isArray(query.keys) ? query.keys.slice(0, 256) : []) {
      let k: string;
      try {
        k = normalizeKey(String(raw));
      } catch {
        continue;
      }
      const e = idx.entries[k];
      if (e && this.hasBlob(e.sha256)) keys[String(raw)] = { sha256: e.sha256, size: e.size };
    }
    for (const raw of Array.isArray(query.hashes) ? query.hashes.slice(0, 256) : []) {
      const h = String(raw);
      const size = HASH_RE.test(h) ? this.blobSize(h) : null;
      if (size !== null) hashes[h] = size;
    }
    return { keys, hashes };
  }

  /**
   * Libera espacio hasta quedar ≤ maxBytes, borrando primero lo menos usado.
   * Solo borra blobs dentro de `<root>/blobs/sha256/` y sus entradas de índice;
   * también los temporales con más de 1 día.
   */
  gc(maxBytes: number): { removed: CacheEntry[]; kept_bytes: number } {
    const idx = this.loadIndex();
    const byHash = new Map<string, CacheEntry[]>();
    for (const e of Object.values(idx.entries)) {
      if (!this.hasBlob(e.sha256)) {
        delete idx.entries[e.key];
        continue;
      }
      byHash.set(e.sha256, [...(byHash.get(e.sha256) ?? []), e]);
    }
    const blobs = [...byHash.entries()].map(([hash, es]) => ({
      hash,
      size: es[0]!.size,
      last: es.map((e) => e.last_used_at).sort().pop()!,
      entries: es,
    }));
    blobs.sort((a, b) => a.last.localeCompare(b.last));
    let total = blobs.reduce((s, b) => s + b.size, 0);
    const removed: CacheEntry[] = [];
    for (const b of blobs) {
      if (total <= maxBytes) break;
      fs.rmSync(this.blobPath(b.hash), { force: true });
      for (const e of b.entries) {
        delete idx.entries[e.key];
        removed.push(e);
      }
      total -= b.size;
    }
    this.saveIndex(idx);
    try {
      const td = path.join(this.root, "tmp");
      const cutoff = Date.now() - 86_400_000;
      for (const f of fs.readdirSync(td)) {
        const p = path.join(td, f);
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      }
    } catch {
      /* sin tmp */
    }
    return { removed, kept_bytes: total };
  }
}

interface Ticket {
  hash: string;
  office_id: string;
  expires_at: number;
}

/** Tickets de descarga de un solo uso, en memoria del servidor. */
export class TicketBook {
  private tickets = new Map<string, Ticket>();
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = TICKET_TTL_MS,
  ) {}

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.tickets) if (v.expires_at <= t) this.tickets.delete(k);
  }

  issue(hash: string, officeId: string): { ticket: string; expires_at: number } {
    if (!HASH_RE.test(hash)) throw new Error("hash inválido");
    this.sweep();
    if (this.tickets.size >= MAX_TICKETS) {
      const oldest = [...this.tickets.entries()].sort((a, b) => a[1].expires_at - b[1].expires_at)[0];
      if (oldest) this.tickets.delete(oldest[0]);
    }
    const ticket = crypto.randomBytes(24).toString("base64url");
    const expires_at = this.now() + this.ttlMs;
    this.tickets.set(ticket, { hash, office_id: officeId, expires_at });
    return { ticket, expires_at };
  }

  /** Consume el ticket. Devuelve el office_id ligado, o null si no vale para ese hash. */
  redeem(ticket: string, hash: string): string | null {
    this.sweep();
    const t = this.tickets.get(ticket);
    if (!t) return null;
    this.tickets.delete(ticket);
    if (t.hash !== hash || t.expires_at <= this.now()) return null;
    return t.office_id;
  }

  get size(): number {
    this.sweep();
    return this.tickets.size;
  }
}
