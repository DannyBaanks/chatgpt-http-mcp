// src/link/store.ts — Persistencia privada (0600) del estado de ISyMCP Link (`munder-link@1`).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bridgeHome } from "../codex-sessions";
import {
  generateIdentity,
  MAX_ORIGINS,
  ORIGIN_TTL_MS,
  type LinkIdentity,
  type LinkPeer,
} from "./crypto";

export interface PendingPair {
  office_id: string;
  name: string;
  sign_pub: string;
  box_pub: string;
  addresses: string[];
  code: string;
  expires_at: number;
}

export interface OriginRecord {
  origin_ref: string;
  task_id: string;
  message_id: string | null;
  to_office: string;
  to_name: string | null;
  payload_hash: string | null;
  created_at: string;
}

export function defaultLinkDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.ISYMCP_LINK_DIR || env.MUNDER_LINK_DIR;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  return path.join(bridgeHome(env), "link");
}

export function legacyMunderLinkDir(env: Record<string, string | undefined> = process.env): string {
  const base = env.MUNDER_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "munder");
  return path.join(base, "link");
}

export function linkFiles(dir = defaultLinkDir()) {
  return {
    identity: path.join(dir, "identity.json"),
    peers: path.join(dir, "peers.json"),
    pending: path.join(dir, "pending.json"),
    origins: path.join(dir, "origins.json"),
    receipts: path.join(dir, "receipts.jsonl"),
    pid: path.join(dir, "link.pid"),
    log: path.join(dir, "link.log"),
  };
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return fallback;
  }
}

export function writePrivateJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* noop */
    }
  }
}

export function loadIdentity(dir = defaultLinkDir(), name?: string | null): LinkIdentity {
  const f = linkFiles(dir).identity;
  const existing = readJsonFile<LinkIdentity | null>(f, null);
  if (existing && existing.sign && existing.box) {
    if (name && existing.name !== name) {
      existing.name = name;
      writePrivateJson(f, existing);
    }
    return existing;
  }
  const created = generateIdentity(name);
  writePrivateJson(f, created);
  return created;
}

export function loadPeers(dir = defaultLinkDir()): Record<string, LinkPeer> {
  return readJsonFile<Record<string, LinkPeer>>(linkFiles(dir).peers, {});
}

export function savePeers(peers: Record<string, LinkPeer>, dir = defaultLinkDir()): void {
  writePrivateJson(linkFiles(dir).peers, peers);
}

export function loadPending(dir = defaultLinkDir(), now = Date.now()): Record<string, PendingPair> {
  const all = readJsonFile<Record<string, PendingPair>>(linkFiles(dir).pending, {});
  return Object.fromEntries(Object.entries(all).filter(([, p]) => p && p.expires_at > now));
}

export function savePending(pending: Record<string, PendingPair>, dir = defaultLinkDir()): void {
  writePrivateJson(linkFiles(dir).pending, pending);
}

export function findPeer(query: string, peers: Record<string, LinkPeer>): LinkPeer | null {
  const q = String(query).toLowerCase().trim();
  if (!q) return null;
  const all = Object.values(peers);
  const short = (p: LinkPeer) => p.name.toLowerCase().replace(/^(?:michael|isymcp)-/, "");
  const exact = all.find((p) => p.office_id === q || p.name.toLowerCase() === q || short(p) === q);
  if (exact) return exact;
  const matches = all.filter((p) => p.office_id.startsWith(q) || p.name.toLowerCase().includes(q));
  return matches.length === 1 ? matches[0]! : null;
}

export function appendReceipt(dir: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(linkFiles(dir).receipts, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
}

export function originKey(peerOfficeId: string, ref: string): string {
  return `${peerOfficeId}|${ref}`;
}

export function checkOriginRef(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const clean = ref.trim();
  if (!clean || clean.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(clean)) return null;
  return clean;
}

export function payloadFingerprint(input: { compose: string; title?: string; priority?: number }): string {
  const normalizedTitle = typeof input.title === "string" ? input.title.trim() : "";
  const normalizedPriority = Number.isInteger(input.priority) ? input.priority : 5;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([String(input.compose).trim(), normalizedTitle, normalizedPriority]))
    .digest("hex");
}

export function loadOrigins(dir = defaultLinkDir()): Record<string, OriginRecord> {
  const all = readJsonFile<Record<string, OriginRecord>>(linkFiles(dir).origins, {});
  const now = Date.now();
  const live = Object.entries(all).filter(([, o]) => o && now - Date.parse(o.created_at || "") < ORIGIN_TTL_MS);
  live.sort((a, b) => Date.parse(a[1].created_at || "") - Date.parse(b[1].created_at || ""));
  return Object.fromEntries(live.slice(-MAX_ORIGINS));
}

export function saveOrigins(origins: Record<string, OriginRecord>, dir = defaultLinkDir()): void {
  writePrivateJson(linkFiles(dir).origins, origins);
}

export function rememberOrigin(opts: {
  dir?: string;
  toOffice: string;
  toName?: string | null;
  originRef: string;
  taskId: string;
  messageId?: string | null;
  payloadHash?: string | null;
}): OriginRecord | null {
  const dir = opts.dir ?? defaultLinkDir();
  const ref = checkOriginRef(opts.originRef);
  if (!ref || !opts.toOffice || !opts.taskId) return null;
  const all = loadOrigins(dir);
  const rec: OriginRecord = {
    origin_ref: ref,
    task_id: opts.taskId,
    message_id: opts.messageId ?? null,
    to_office: opts.toOffice,
    to_name: opts.toName ?? null,
    payload_hash: opts.payloadHash ?? null,
    created_at: new Date().toISOString(),
  };
  all[originKey(opts.toOffice, ref)] = rec;
  saveOrigins(all, dir);
  return rec;
}

/**
 * Importa de forma NO destructiva identidad y peers desde `~/.local/state/munder/link`
 * para migrar desde `isyco-worlds` sin re-emparejar máquinas existentes.
 * Por seguridad, todos los peers importados nacen con `compute: false`.
 */
export function importLegacyMunderLink(
  targetDir = defaultLinkDir(),
  sourceDir = legacyMunderLinkDir(),
): { imported_identity: boolean; imported_peers: number } {
  const src = linkFiles(sourceDir);
  const dst = linkFiles(targetDir);
  let importedIdentity = false;
  if (!fs.existsSync(dst.identity) && fs.existsSync(src.identity)) {
    const id = readJsonFile<LinkIdentity | null>(src.identity, null);
    if (id && id.sign && id.box) {
      writePrivateJson(dst.identity, id);
      importedIdentity = true;
    }
  }
  let importedPeers = 0;
  if (fs.existsSync(src.peers)) {
    const srcPeers = readJsonFile<Record<string, LinkPeer>>(src.peers, {});
    const dstPeers = loadPeers(targetDir);
    for (const [id, peer] of Object.entries(srcPeers)) {
      if (!dstPeers[id]) {
        dstPeers[id] = {
          ...peer,
          authority: { office: true, compute: false },
        };
        importedPeers++;
      }
    }
    if (importedPeers > 0) savePeers(dstPeers, targetDir);
  }
  return { imported_identity: importedIdentity, imported_peers: importedPeers };
}
