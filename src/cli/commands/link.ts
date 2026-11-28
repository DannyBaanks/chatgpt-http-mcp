// src/cli/commands/link.ts — CLI de ISyMCP Link (`munder-link@1` + autoridad compute fail-closed).
import fs from "node:fs";
import type { CliModule } from "../module";
import { defaultHiveRoot } from "../../hive/manager";
import { ComputeQueue, createComputeRpcHandler, defaultComputeJobsDir } from "../../compute/queue";
import { peerAuthority, setPeerComputeAuthority } from "../../link/authority";
import { acceptPending, call, delegate, forgetPeer, reply, requestPair, trustPeer } from "../../link/client";
import { DEFAULT_PORT, prettyFingerprint } from "../../link/crypto";
import { createDiscoveryResponder, discoverLan, discoverTailscale } from "../../link/discovery";
import { createLinkServer } from "../../link/server";
import { defaultLinkDir, importLegacyMunderLink, linkFiles, loadIdentity, loadPeers } from "../../link/store";
import { CacheStore } from "../../link/cache";
import { cacheFetch } from "../../link/cache-client";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function linkHelp(): void {
  console.log(`isymcp link — Enlace cifrado E2E (munder-link@1) + permiso compute

Uso:
  isymcp link serve [--port 47831] [--hive <dir> | --no-hive] [--max-gpu 1] [--max-cpu <n>] [--dir <dir>]
  isymcp link discover
  isymcp link pair <ip[:puerto]> [--accept]
  isymcp link accept <codigo-6-digitos>
  isymcp link peers
  isymcp link forget <peer>
  isymcp link import-legacy
  isymcp link status <peer>
  isymcp link submit <peer> <texto> [--title <titulo>] [--priority <1-10>]
  isymcp link task <peer> <task_id>
  isymcp link reply <peer> <origin_ref> <texto> [--result <res>] [--status <st>]
  isymcp link compute allow <peer>
  isymcp link compute revoke <peer>
  isymcp link cache fetch <url|hf:...> [-o dest]
  isymcp link cache put <archivo> [--key <clave>]
  isymcp link cache ls
  isymcp link cache gc --max-gb <N>`);
}

export const linkModule: CliModule = {
  names: ["link"],
  async run(sub, rest) {
    const dir = flagValue(rest, "--dir") ?? defaultLinkDir();
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      linkHelp();
      return;
    }

    switch (sub) {
      case "serve": {
        const port = Number(flagValue(rest, "--port") ?? DEFAULT_PORT);
        const noHive = rest.includes("--no-hive");
        const hiveRoot = noHive ? null : (flagValue(rest, "--hive") ?? defaultHiveRoot());
        const maxGpu = Number(flagValue(rest, "--max-gpu") ?? 1);
        const maxCpuRaw = flagValue(rest, "--max-cpu");
        const queue = new ComputeQueue({
          jobsDir: flagValue(rest, "--jobs-dir") ?? defaultComputeJobsDir(),
          maxGpuSlots: Number.isFinite(maxGpu) ? maxGpu : 1,
          maxCpuSlots: maxCpuRaw ? Number(maxCpuRaw) : undefined,
        });

        const { server, identity } = createLinkServer({
          dir,
          hiveRoot,
          computeHandler: createComputeRpcHandler(queue),
        });

        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "0.0.0.0", () => resolve());
        });

        const actualPort = (server.address() as { port: number }).port;
        const udp = createDiscoveryResponder({ dir, port: actualPort });
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(linkFiles(dir).pid, String(process.pid), "utf8");
        } catch {
          /* best effort */
        }

        console.log(
          `[isymcp-link] ${identity.name} (${prettyFingerprint(identity.office_id)}) escuchando en 0.0.0.0:${actualPort} | hive=${hiveRoot ?? "compute-only"} | gpu_slots=${queue.maxGpuSlots} cpu_slots=${queue.maxCpuSlots}`,
        );

        await new Promise<void>((resolve) => {
          const bye = () => {
            try {
              udp.close();
            } catch {
              /* closed */
            }
            server.close(() => resolve());
          };
          process.once("SIGINT", bye);
          process.once("SIGTERM", bye);
        });
        return;
      }

      case "discover": {
        const [lan, ts] = await Promise.all([discoverLan({ dir }), discoverTailscale({ dir })]);
        console.log(JSON.stringify({ lan, tailscale: ts }, null, 2));
        return;
      }

      case "pair": {
        const addr = rest[0];
        if (!addr) {
          console.error("Uso: isymcp link pair <ip[:puerto]> [--accept]");
          process.exit(2);
        }
        const res = await requestPair(addr, { dir });
        if (rest.includes("--accept")) {
          trustPeer(res.peer, dir);
        }
        console.log(
          JSON.stringify(
            {
              peer: { office_id: res.peer.office_id, name: res.peer.name, addresses: res.peer.addresses },
              code: res.code,
              trusted_locally: rest.includes("--accept"),
              next_step: `En la máquina remota ejecuta: isymcp link accept ${res.code}`,
            },
            null,
            2,
          ),
        );
        return;
      }

      case "accept": {
        const code = rest[0];
        if (!code) {
          console.error("Uso: isymcp link accept <codigo-6-digitos>");
          process.exit(2);
        }
        const peer = acceptPending(code, dir);
        if (!peer) {
          console.error("No hay ninguna solicitud pendiente con ese código (o expiró).");
          process.exit(1);
        }
        console.log(JSON.stringify({ ok: true, peer: { office_id: peer.office_id, name: peer.name, authority: peerAuthority(peer) } }, null, 2));
        return;
      }

      case "peers": {
        const id = loadIdentity(dir);
        const peers = Object.values(loadPeers(dir)).map((p) => ({
          office_id: p.office_id,
          name: p.name,
          fingerprint: prettyFingerprint(p.office_id),
          addresses: p.addresses,
          authority: peerAuthority(p),
          paired_at: p.paired_at,
        }));
        console.log(JSON.stringify({ self: { office_id: id.office_id, name: id.name, fingerprint: prettyFingerprint(id.office_id) }, peers }, null, 2));
        return;
      }

      case "forget": {
        const q = rest[0];
        if (!q) {
          console.error("Uso: isymcp link forget <peer>");
          process.exit(2);
        }
        const removed = forgetPeer(q, dir);
        if (!removed) {
          console.error(`Peer no encontrado: ${q}`);
          process.exit(1);
        }
        console.log(JSON.stringify({ ok: true, removed: { office_id: removed.office_id, name: removed.name } }, null, 2));
        return;
      }

      case "import-legacy": {
        const res = importLegacyMunderLink(dir);
        console.log(JSON.stringify({ ok: true, dir, ...res }, null, 2));
        return;
      }

      case "status": {
        const peer = rest[0];
        if (!peer) {
          console.error("Uso: isymcp link status <peer>");
          process.exit(2);
        }
        const res = await call(peer, "status", {}, { dir });
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      case "submit": {
        const [peer, compose] = rest;
        if (!peer || !compose) {
          console.error("Uso: isymcp link submit <peer> <texto> [--title <t>] [--priority <n>]");
          process.exit(2);
        }
        const title = flagValue(rest, "--title");
        const prioRaw = flagValue(rest, "--priority");
        const res = await delegate(peer, compose, {
          title,
          priority: prioRaw ? Number(prioRaw) : undefined,
          dir,
        });
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      case "task": {
        const [peer, taskId] = rest;
        if (!peer || !taskId) {
          console.error("Uso: isymcp link task <peer> <task_id>");
          process.exit(2);
        }
        const res = await call(peer, "get", { task_id: taskId }, { dir });
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      case "reply": {
        const [peer, originRef, text] = rest;
        if (!peer || !originRef) {
          console.error("Uso: isymcp link reply <peer> <origin_ref> <texto> [--result <r>] [--status <s>]");
          process.exit(2);
        }
        const res = await reply(peer, originRef, {
          text,
          result: flagValue(rest, "--result"),
          status: flagValue(rest, "--status"),
          dir,
        });
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      case "cache": {
        const action = rest[0];
        if (action === "fetch") {
          const key = rest[1];
          if (!key) {
            console.error("Uso: isymcp link cache fetch <url|hf:...> [-o dest]");
            process.exit(2);
          }
          const output = flagValue(rest, "-o") ?? flagValue(rest, "--output");
          const res = await cacheFetch(key, { linkDir: dir, output });
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        if (action === "put") {
          const file = rest[1];
          if (!file) {
            console.error("Uso: isymcp link cache put <archivo> [--key <clave>]");
            process.exit(2);
          }
          const entry = await new CacheStore().put(file, flagValue(rest, "--key"));
          console.log(JSON.stringify(entry, null, 2));
          return;
        }
        if (action === "ls") {
          console.log(JSON.stringify(new CacheStore().ls(), null, 2));
          return;
        }
        if (action === "gc") {
          const gb = Number(flagValue(rest, "--max-gb"));
          if (!Number.isFinite(gb) || gb <= 0) {
            console.error("Uso: isymcp link cache gc --max-gb <N>");
            process.exit(2);
          }
          const res = new CacheStore().gc(Math.floor(gb * 1_000_000_000));
          console.log(JSON.stringify({ ok: true, removed: res.removed.length, kept_bytes: res.kept_bytes, removed_entries: res.removed }, null, 2));
          return;
        }
        console.error("Uso: isymcp link cache fetch|put|ls|gc");
        process.exit(2);
      }

      case "compute": {
        const [action, peer] = rest;
        if ((action !== "allow" && action !== "revoke") || !peer) {
          console.error("Uso: isymcp link compute allow|revoke <peer>");
          process.exit(2);
        }
        const updated = setPeerComputeAuthority(peer, action === "allow", dir);
        if (!updated) {
          console.error(`Peer no encontrado: ${peer}`);
          process.exit(1);
        }
        console.log(JSON.stringify({ ok: true, peer: updated.peer.name, office_id: updated.peer.office_id, authority: updated.authority }, null, 2));
        return;
      }

      default:
        linkHelp();
        process.exit(2);
    }
  },
};
