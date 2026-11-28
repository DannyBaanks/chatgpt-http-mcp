// src/link/cache-client.ts — `cache fetch`: local → peers (cache_has/cache_ticket + GET con Range) → internet.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CacheStore, HASH_RE, keyToUrl, normalizeKey, type CacheEntry } from "./cache";
import { call } from "./client";
import { LinkError } from "./crypto";
import { defaultLinkDir, loadPeers } from "./store";

export type FetchSource = "local" | `peer:${string}` | "internet";

export interface CacheFetchResult {
  key: string;
  sha256: string;
  size: number;
  source: FetchSource;
  blob: string;
  output: string | null;
  bytes_transferred: number;
  ms: number;
  tried: { peer: string; outcome: string }[];
}

export interface CacheFetchOptions {
  store?: CacheStore;
  linkDir?: string;
  /** Peers a consultar (nombre u office_id). Por defecto, todos los emparejados. */
  peers?: string[];
  /** No consultar peers. */
  noPeers?: boolean;
  /** No bajar de internet (solo local/peers). */
  noInternet?: boolean;
  /** sha256 esperado (si se conoce): se exige a cualquier fuente. */
  expected?: string;
  output?: string;
  /** Inyectable en tests. */
  fetchImpl?: typeof fetch;
  peerTimeoutMs?: number;
  onProgress?: (bytes: number) => void;
}

async function streamToFile(
  res: Response,
  file: string,
  append: boolean,
  onProgress?: (bytes: number) => void,
): Promise<number> {
  if (!res.body) throw new Error("respuesta sin cuerpo");
  const out = fs.createWriteStream(file, { flags: append ? "a" : "w", mode: 0o600 });
  let n = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      onProgress?.(n);
    }
  } finally {
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  }
  return n;
}

/** Descarga reanudable a `part`: si ya hay bytes, pide `Range: bytes=<n>-`. */
async function resumableGet(
  url: string,
  part: string,
  f: typeof fetch,
  onProgress?: (bytes: number) => void,
): Promise<number> {
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await f(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, redirect: "follow" });
  if (res.status === 416 && have > 0) return 0; // ya estaba completo
  if (res.status === 206 && have > 0) return streamToFile(res, part, true, onProgress);
  if (res.status === 200) return streamToFile(res, part, false, onProgress);
  throw new Error(`HTTP ${res.status}`);
}

function materialize(blob: string, output: string | undefined): string | null {
  if (!output) return null;
  const dest = path.resolve(output);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.linkSync(blob, tmp); // mismo FS: sin copiar (los blobs no se modifican nunca)
  } catch {
    fs.copyFileSync(blob, tmp);
  }
  fs.renameSync(tmp, dest);
  return dest;
}

export async function cacheFetch(rawKey: string, opts: CacheFetchOptions = {}): Promise<CacheFetchResult> {
  const started = Date.now();
  const store = opts.store ?? new CacheStore();
  const f = opts.fetchImpl ?? fetch;
  const key = normalizeKey(rawKey);
  const expected = opts.expected?.toLowerCase();
  if (expected && !HASH_RE.test(expected)) throw new Error("--sha256 debe ser un hash sha256 hex");
  const tried: { peer: string; outcome: string }[] = [];
  const done = (entry: CacheEntry, source: FetchSource, bytes: number): CacheFetchResult => {
    const blob = store.blobPath(entry.sha256);
    return {
      key,
      sha256: entry.sha256,
      size: entry.size,
      source,
      blob,
      output: materialize(blob, opts.output),
      bytes_transferred: bytes,
      ms: Date.now() - started,
      tried,
    };
  };

  // 1) local (por clave, o por hash si se conoce)
  const local = store.lookup(key);
  if (local && (!expected || local.sha256 === expected)) {
    store.touch(key);
    return done(local, "local", 0);
  }
  if (expected && store.hasBlob(expected)) {
    return done(store.record(key, expected, store.blobSize(expected)!, "local"), "local", 0);
  }

  // 2) peers
  if (!opts.noPeers) {
    const linkDir = opts.linkDir ?? defaultLinkDir();
    const names = opts.peers?.length ? opts.peers : Object.values(loadPeers(linkDir)).map((p) => p.office_id);
    for (const q of names) {
      try {
        const has = await call<{ keys: Record<string, { sha256: string; size: number }>; hashes: Record<string, number> }>(
          q,
          "cache_has",
          { keys: [key], hashes: expected ? [expected] : [] },
          { dir: linkDir, timeoutMs: opts.peerTimeoutMs ?? 2500 },
        );
        const hit = has.result.keys[key]?.sha256 ?? (expected && has.result.hashes[expected] !== undefined ? expected : null);
        if (!hit || (expected && hit !== expected)) {
          tried.push({ peer: has.peer.name, outcome: "miss" });
          continue;
        }
        const part = path.join(store.tmpDir(), `peer-${hit}.part`);
        let bytes = 0;
        // Hasta 3 intentos: cada uno con ticket nuevo (un solo uso), reanudando el .part.
        for (let attempt = 0; attempt < 3; attempt++) {
          const tk = await call<{ path: string }>(q, "cache_ticket", { hash: hit }, { dir: linkDir, timeoutMs: opts.peerTimeoutMs ?? 2500 });
          try {
            bytes += await resumableGet(`http://${tk.address}${tk.result.path}`, part, f, opts.onProgress);
            break;
          } catch (e) {
            if (attempt === 2) throw e;
          }
        }
        const entry = (await store.adoptTemp(part, { expected: hit, key, source: `peer:${has.peer.name}` })) as CacheEntry;
        tried.push({ peer: has.peer.name, outcome: "hit" });
        return done(entry, `peer:${has.peer.name}`, bytes);
      } catch (e) {
        tried.push({ peer: q, outcome: e instanceof LinkError ? e.code : (e as Error).message });
      }
    }
  }

  // 3) internet
  if (opts.noInternet) throw new Error(`«${key}» no está en la caché local ni en los peers`);
  const url = keyToUrl(key);
  if (!url) throw new Error(`«${key}» no es descargable (usa una URL http(s) o hf:<org>/<repo>[@rev]/<archivo>)`);
  const part = path.join(store.tmpDir(), `net-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}.part`);
  const bytes = await resumableGet(url, part, f, opts.onProgress);
  const entry = (await store.adoptTemp(part, { expected, key, source: url })) as CacheEntry;
  return done(entry, "internet", bytes);
}
