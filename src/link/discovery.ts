// src/link/discovery.ts — Descubrimiento LAN (UDP broadcast) + Tailscale para ISyMCP Link.
import dgram from "node:dgram";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_PORT,
  DISCOVERY_PORT,
  isPrivateV4,
  MAX_DISCOVERY_ATTEMPTS,
  MAX_DISCOVERY_TARGETS,
  officeIdOf,
  PROBE,
  PROTOCOL,
  publicCard,
} from "./crypto";
import { defaultLinkDir, loadIdentity } from "./store";
import { hello, hostPort } from "./client";

export interface DiscoveredOffice {
  protocol: string;
  office_id: string;
  name: string;
  sign_pub: string;
  box_pub: string;
  address: string;
  via: "lan" | "tailscale";
  version?: string;
  host?: string;
}

export function createDiscoveryResponder(opts: {
  dir?: string;
  port?: number;
  version?: string;
  udpPort?: number;
} = {}): dgram.Socket {
  const dir = opts.dir ?? defaultLinkDir();
  const port = opts.port ?? DEFAULT_PORT;
  const version = opts.version ?? "isymcp";
  const udpPort = opts.udpPort ?? DISCOVERY_PORT;
  const identity = loadIdentity(dir);

  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sock.on("message", (msg, rinfo) => {
    if (!isPrivateV4(rinfo.address)) return;
    if (msg.toString("utf8") !== PROBE) return;
    const reply = Buffer.from(JSON.stringify({ ...publicCard(identity), port, version }));
    sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.on("error", () => {
    /* best effort */
  });
  sock.bind(udpPort);
  return sock;
}

export function broadcastAddresses(): string[] {
  const out = new Set<string>(["255.255.255.255"]);
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|cni|flannel|podman)/.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || !a.netmask) continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      out.add(ip.map((o, i) => o | (~mask[i]! & 255)).join("."));
    }
  }
  return [...out];
}

export function discoverLan(opts: {
  timeoutMs?: number;
  targets?: string[];
  udpPort?: number;
  dir?: string;
  attempts?: number;
} = {}): Promise<DiscoveredOffice[]> {
  const dir = opts.dir ?? defaultLinkDir();
  const me = loadIdentity(dir).office_id;
  const budget = Math.min(Math.max(200, Number(opts.timeoutMs ?? 1500) || 1500), 15_000);
  const rounds = Math.min(MAX_DISCOVERY_ATTEMPTS, Math.max(1, Number(opts.attempts ?? 3) || 1));
  const list = [...new Set((opts.targets ?? broadcastAddresses()).map(String))].slice(0, MAX_DISCOVERY_TARGETS);
  const udpPort = opts.udpPort ?? DISCOVERY_PORT;
  const gap = Math.max(50, Math.floor(budget / (rounds + 1)));

  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredOffice>();
    let sock: dgram.Socket | null = null;
    let sweepTimer: ReturnType<typeof setInterval> | null = null;
    let doneTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      if (sweepTimer) clearInterval(sweepTimer);
      if (doneTimer) clearTimeout(doneTimer);
      try {
        sock?.close();
      } catch {
        /* closed */
      }
      resolve([...found.values()]);
    };

    sock = dgram.createSocket("udp4");
    sock.on("message", (msg, rinfo) => {
      try {
        const c = JSON.parse(msg.toString("utf8")) as Record<string, unknown>;
        if (
          c.protocol !== PROTOCOL ||
          c.office_id === me ||
          typeof c.sign_pub !== "string" ||
          typeof c.box_pub !== "string" ||
          officeIdOf(c.sign_pub) !== c.office_id
        ) {
          return;
        }
        found.set(String(c.office_id), {
          protocol: PROTOCOL,
          office_id: String(c.office_id),
          name: String(c.name || "desconocida"),
          sign_pub: c.sign_pub,
          box_pub: c.box_pub,
          address: `${rinfo.address}:${Number(c.port) || DEFAULT_PORT}`,
          via: "lan",
          version: typeof c.version === "string" ? c.version : undefined,
        });
      } catch {
        /* ignore noise */
      }
    });
    sock.on("error", () => {
      /* best effort */
    });
    sock.bind(0, () => {
      if (closed) return;
      try {
        sock?.setBroadcast(true);
      } catch {
        /* noop */
      }
      const sweep = () => {
        if (closed) return;
        for (const t of list) {
          try {
            sock?.send(PROBE, udpPort, t, () => {});
          } catch {
            /* noop */
          }
        }
      };
      sweep();
      sweepTimer = setInterval(sweep, gap);
    });
    doneTimer = setTimeout(finish, budget);
  });
}

export async function discoverTailscale(opts: {
  timeoutMs?: number;
  dir?: string;
} = {}): Promise<{ available: boolean; offices: DiscoveredOffice[] }> {
  const dir = opts.dir ?? defaultLinkDir();
  const timeoutMs = opts.timeoutMs ?? 1500;
  let status: { Peer?: Record<string, { Online?: boolean; TailscaleIPs?: string[]; HostName?: string }> };
  try {
    status = JSON.parse(
      execFileSync("tailscale", ["status", "--json"], {
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return { available: false, offices: [] };
  }
  const me = loadIdentity(dir).office_id;
  const peers = Object.values(status.Peer ?? {})
    .filter((p) => p.Online && Array.isArray(p.TailscaleIPs) && p.TailscaleIPs.length > 0)
    .slice(0, 32);
  const deadline = Date.now() + Math.max(1500, timeoutMs) * 2;
  const results = await Promise.all(
    peers.map(async (p): Promise<DiscoveredOffice | null> => {
      const remaining = Math.max(1, deadline - Date.now());
      const ip = p.TailscaleIPs!.find((x) => !x.includes(":")) || p.TailscaleIPs![0]!;
      try {
        const c = await hello(ip, Math.min(timeoutMs, remaining));
        if (c.office_id === me) return null;
        return {
          protocol: PROTOCOL,
          office_id: String(c.office_id),
          name: String(c.name || p.HostName || "unknown"),
          sign_pub: String(c.sign_pub),
          box_pub: String(c.box_pub),
          address: hostPort(ip),
          via: "tailscale",
          version: typeof c.version === "string" ? c.version : undefined,
          host: p.HostName,
        };
      } catch {
        return null;
      }
    }),
  );
  return { available: true, offices: results.filter((x): x is DiscoveredOffice => x !== null) };
}
