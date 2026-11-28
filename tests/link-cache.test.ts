import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheStore, TicketBook, sha256File } from "../src/link/cache";
import { cacheFetch } from "../src/link/cache-client";
import { createLinkServer } from "../src/link/server";
import { acceptPending, call, requestPair, trustPeer } from "../src/link/client";

const cleanupDirs: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

describe("CacheStore", () => {
  test("put/lookup: guarda, verifica hash y reusa el blob", async () => {
    const root = makeTmp("isymcp-cache-store-");
    const store = new CacheStore(root);
    const f = join(root, "origen.txt");
    writeFileSync(f, "hola caché");
    const entry = await store.put(f, "key:origen.txt");
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.size).toBe(Buffer.byteLength("hola caché"));
    expect(await sha256File(f)).toBe(entry.sha256);
    expect(store.lookup("key:origen.txt")?.sha256).toBe(entry.sha256);
    const entry2 = await store.put(f, "key:origen.txt");
    expect(entry2.sha256).toBe(entry.sha256);
    expect(store.ls().length).toBe(1);
  });

  test("adoptTemp rechaza hash esperado que no coincide y borra el temporal", async () => {
    const root = makeTmp("isymcp-cache-corrupt-");
    const store = new CacheStore(root);
    const tmp = join(store.tmpDir(), "malo.tmp");
    writeFileSync(tmp, "contenido");
    await expect(store.adoptTemp(tmp, { expected: "0".repeat(64) })).rejects.toThrow(/hash no coincide/);
    expect(existsSync(tmp)).toBe(false);
    expect(store.ls().length).toBe(0);
  });

  test("índice corrupto se reconstruye vacío en vez de romper", () => {
    const root = makeTmp("isymcp-cache-index-");
    const store = new CacheStore(root);
    writeFileSync(join(root, "index.json"), "{no-json");
    expect(store.loadIndex()).toEqual({ version: 1, entries: {} });
    expect(store.ls()).toEqual([]);
  });

  test("gc libera lo menos usado hasta el presupuesto", async () => {
    const root = makeTmp("isymcp-cache-gc-");
    const store = new CacheStore(root);
    const mk = async (name: string, content: string, key: string) => {
      const f = join(root, name);
      writeFileSync(f, content);
      return store.put(f, key);
    };
    const a = await mk("a.txt", "AAAA", "key:a");
    await new Promise((r) => setTimeout(r, 5));
    const b = await mk("b.txt", "BBBB", "key:b");
    const res = store.gc(4);
    expect(res.removed.map((e) => e.key)).toContain("key:a");
    expect(res.kept_bytes).toBe(4);
    expect(store.lookup("key:a")).toBeNull();
    expect(store.lookup("key:b")?.sha256).toBe(b.sha256);
    expect(existsSync(store.blobPath(a.sha256))).toBe(false);
  });
});

describe("TicketBook", () => {
  test("un solo uso, ligado al peer y con caducidad", () => {
    let now = 1_000_000;
    const book = new TicketBook(() => now);
    const t1 = book.issue("a".repeat(64), "office-1");
    expect(book.redeem(t1.ticket, "a".repeat(64))).toBe("office-1");
    expect(book.redeem(t1.ticket, "a".repeat(64))).toBeNull();
    const t2 = book.issue("b".repeat(64), "office-2");
    expect(book.redeem(t2.ticket, "a".repeat(64))).toBeNull();
    const t2b = book.issue("b".repeat(64), "office-2");
    expect(book.redeem(t2b.ticket, "b".repeat(64))).toBe("office-2");
    const t3 = book.issue("c".repeat(64), "office-3");
    now += 61_000;
    expect(book.redeem(t3.ticket, "c".repeat(64))).toBeNull();
  });

  test("hash inválido no emite ticket", () => {
    expect(() => new TicketBook().issue("no-es-hash", "office-1")).toThrow(/hash inválido/);
  });
});

describe("E2E loopback: fetch de peer con Range y reanudación", () => {
  test("dos link serve temporales: cache_has/cache_ticket + GET con Range", async () => {
    const dirA = makeTmp("isymcp-cache-e2e-a-");
    const dirB = makeTmp("isymcp-cache-e2e-b-");
    const cacheA = new CacheStore(join(dirA, "cache"));
    const cacheB = new CacheStore(join(dirB, "cache"));
    const { server: srvB } = createLinkServer({ dir: dirB, cache: cacheB });
    await new Promise<void>((r) => srvB.listen(0, "127.0.0.1", r));
    const portB = (srvB.address() as AddressInfo).port;
    try {
      const pairReq = await requestPair(`127.0.0.1:${portB}`, { dir: dirA, port: 47831 });
      const acceptedOnB = acceptPending(pairReq.code, dirB);
      expect(acceptedOnB).not.toBeNull();
      trustPeer(pairReq.peer, dirA);

      const content = Buffer.from("contenido compartido por cable\n".repeat(100));
      const srcFile = join(dirB, "origen.bin");
      writeFileSync(srcFile, content);
      const entryB = await cacheB.put(srcFile, "key:origen.bin");
      const hash = entryB.sha256;

      const res = await cacheFetch("key:origen.bin", { store: cacheA, linkDir: dirA, peers: [pairReq.peer.office_id] });
      expect(res.source).toMatch(/^peer:/);
      expect(res.sha256).toBe(hash);
      expect(readFileSync(cacheA.blobPath(hash)).equals(content)).toBe(true);
      expect(res.bytes_transferred).toBe(content.length);

      const res2 = await cacheFetch("key:origen.bin", { store: cacheA, linkDir: dirA });
      expect(res2.source).toBe("local");
      expect(res2.bytes_transferred).toBe(0);

      const tk = await call<{ path: string }>(pairReq.peer.office_id, "cache_ticket", { hash }, { dir: dirA });
      const base = `http://${tk.address}${tk.result.path}`;
      const r206 = await fetch(base, { headers: { Range: "bytes=0-9" } });
      expect(r206.status).toBe(206);
      expect(r206.headers.get("Content-Range")).toBe(`bytes 0-9/${content.length}`);
      expect(Buffer.from(await r206.arrayBuffer()).equals(content.subarray(0, 10))).toBe(true);
      expect((await fetch(base)).status).toBe(403);

      const tk2 = await call<{ path: string }>(pairReq.peer.office_id, "cache_ticket", { hash }, { dir: dirA });
      const r416 = await fetch(`http://${tk2.address}${tk2.result.path}`, { headers: { Range: `bytes=${content.length + 100}-` } });
      expect(r416.status).toBe(416);

      const cacheA2 = new CacheStore(join(dirA, "cache2"));
      const half = Math.floor(content.length / 2);
      writeFileSync(join(cacheA2.tmpDir(), `peer-${hash}.part`), content.subarray(0, half));
      const res3 = await cacheFetch("key:origen.bin", { store: cacheA2, linkDir: dirA, peers: [pairReq.peer.office_id] });
      expect(res3.source).toMatch(/^peer:/);
      expect(res3.bytes_transferred).toBe(content.length - half);
      expect(readFileSync(cacheA2.blobPath(hash)).equals(content)).toBe(true);
    } finally {
      srvB.close();
    }
  }, 30_000);
});
