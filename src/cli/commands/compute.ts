// src/cli/commands/compute.ts — CLI para despacho async de procesos/GPU hacia peers emparejados.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CliModule } from "../module";
import { call } from "../../link/client";
import { defaultLinkDir } from "../../link/store";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function collectFlags(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]!);
  }
  return out;
}

function computeHelp(): void {
  console.log(`isymcp compute — Ejecución remota asíncrona CPU/WSL2/GPU sobre ISyMCP Link

Uso:
  isymcp compute telemetry <peer>
  isymcp compute submit <peer> --cmd "<comando>" [--target auto|win|wsl|posix] [--gpu] [--priority idle|below_normal|normal] [--timeout <ms>] [--file <local>:<remoto>]
  isymcp compute status <peer> <job_id> [--stdout-offset <n>] [--stderr-offset <n>]
  isymcp compute list <peer> [--limit <n>]
  isymcp compute cancel <peer> <job_id>
  isymcp compute fetch <peer> <job_id> <remote_path> --out <local_path>`);
}

export const computeModule: CliModule = {
  names: ["compute"],
  async run(sub, rest) {
    const dir = flagValue(rest, "--dir") ?? defaultLinkDir();
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      computeHelp();
      return;
    }

    switch (sub) {
      case "telemetry": {
        const peer = rest[0];
        if (!peer) {
          console.error("Uso: isymcp compute telemetry <peer>");
          process.exit(2);
        }
        const res = await call(peer, "host_telemetry", {}, { dir });
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      case "submit": {
        const peer = rest[0];
        const command = flagValue(rest, "--cmd") ?? flagValue(rest, "--command");
        if (!peer || !command) {
          console.error('Uso: isymcp compute submit <peer> --cmd "<comando>" [--target auto|win|wsl|posix] [--gpu]');
          process.exit(2);
        }
        const files = collectFlags(rest, "--file").map((spec) => {
          const sep = spec.lastIndexOf(":");
          const localPath = sep > 0 ? spec.slice(0, sep) : spec;
          const remotePath = sep > 0 ? spec.slice(sep + 1) : path.basename(localPath);
          return { path: remotePath, content_b64: fs.readFileSync(localPath).toString("base64") };
        });
        const timeoutRaw = flagValue(rest, "--timeout");
        const res = await call(
          peer,
          "job_submit",
          {
            command,
            target: flagValue(rest, "--target") ?? "auto",
            wsl_distro: flagValue(rest, "--wsl-distro"),
            cwd: flagValue(rest, "--cwd"),
            gpu: rest.includes("--gpu"),
            priority: flagValue(rest, "--priority") ?? "below_normal",
            timeout_ms: timeoutRaw ? Number(timeoutRaw) : undefined,
            label: flagValue(rest, "--label"),
            files: files.length ? files : undefined,
          },
          { dir },
        );
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      case "status": {
        const [peer, jobId] = rest;
        if (!peer || !jobId) {
          console.error("Uso: isymcp compute status <peer> <job_id>");
          process.exit(2);
        }
        const res = await call(
          peer,
          "job_status",
          {
            job_id: jobId,
            stdout_offset: Number(flagValue(rest, "--stdout-offset") ?? 0),
            stderr_offset: Number(flagValue(rest, "--stderr-offset") ?? 0),
          },
          { dir },
        );
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      case "list": {
        const peer = rest[0];
        if (!peer) {
          console.error("Uso: isymcp compute list <peer>");
          process.exit(2);
        }
        const res = await call(peer, "job_list", { limit: Number(flagValue(rest, "--limit") ?? 50) }, { dir });
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      case "cancel": {
        const [peer, jobId] = rest;
        if (!peer || !jobId) {
          console.error("Uso: isymcp compute cancel <peer> <job_id>");
          process.exit(2);
        }
        const res = await call(peer, "job_cancel", { job_id: jobId }, { dir });
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      case "fetch": {
        const [peer, jobId, remotePath] = rest;
        const outPath = flagValue(rest, "--out");
        if (!peer || !jobId || !remotePath || !outPath) {
          console.error("Uso: isymcp compute fetch <peer> <job_id> <remote_path> --out <local_path>");
          process.exit(2);
        }
        const chunks: Buffer[] = [];
        let offset = 0;
        let expectedSha = "";
        while (true) {
          const r = await call<{ chunk_b64: string; next_offset: number; eof: boolean; sha256: string }>(
            peer,
            "job_fetch",
            { job_id: jobId, path: remotePath, offset },
            { dir },
          );
          chunks.push(Buffer.from(r.result.chunk_b64, "base64"));
          expectedSha = r.result.sha256;
          offset = r.result.next_offset;
          if (r.result.eof) break;
        }
        const buf = Buffer.concat(chunks);
        const actualSha = crypto.createHash("sha256").update(buf).digest("hex");
        if (actualSha !== expectedSha) {
          console.error(`SHA-256 mismatch: expected=${expectedSha} actual=${actualSha}`);
          process.exit(1);
        }
        fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
        fs.writeFileSync(outPath, buf);
        console.log(JSON.stringify({ ok: true, out: path.resolve(outPath), bytes: buf.length, sha256: actualSha }, null, 2));
        return;
      }

      default:
        computeHelp();
        process.exit(2);
    }
  },
};
