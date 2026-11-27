import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeQueue, createComputeRpcHandler } from "../src/compute/queue";
import { createLinkServer } from "../src/link/server";
import { acceptPending, call, requestPair, trustPeer } from "../src/link/client";
import { setPeerComputeAuthority } from "../src/link/authority";

const cleanupDirs: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

async function waitForDone(
  dirClient: string,
  peerId: string,
  jobId: string,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await call<Record<string, unknown>>(peerId, "job_status", { job_id: jobId }, { dir: dirClient });
    const st = String(r.result.status);
    if (st !== "queued" && st !== "running") return r.result;
    await new Promise((res) => setTimeout(res, 60));
  }
  throw new Error(`timeout waiting for ${jobId}`);
}

describe("ComputeQueue + Link RPC (async, GPU slots, logs, cancel, chunked fetch)", () => {
  test("ejecución async, streaming incremental de logs, descarga por chunks >300KB con SHA-256 y cancelación", async () => {
    const dirClient = makeTmp("isymcp-comp-cli-");
    const dirOther = makeTmp("isymcp-comp-other-");
    const dirHost = makeTmp("isymcp-comp-host-");
    const queue = new ComputeQueue({ jobsDir: join(dirHost, "jobs"), maxGpuSlots: 1, maxCpuSlots: 2 });

    const { server } = createLinkServer({
      dir: dirHost,
      hiveRoot: null, // modo compute-only sin hive
      computeHandler: createComputeRpcHandler(queue),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const addr = `127.0.0.1:${port}`;

    try {
      // Emparejar cliente principal + otro peer y conceder compute a ambos
      const p1 = await requestPair(addr, { dir: dirClient, port: 47831 });
      const acc1 = acceptPending(p1.code, dirHost)!;
      trustPeer(p1.peer, dirClient);
      setPeerComputeAuthority(acc1.office_id, true, dirHost);

      const p2 = await requestPair(addr, { dir: dirOther, port: 47831 });
      const acc2 = acceptPending(p2.code, dirHost)!;
      trustPeer(p2.peer, dirOther);
      setPeerComputeAuthority(acc2.office_id, true, dirHost);

      // 1. Telemetría
      const tel = await call<{ slots: { gpu_max: number } }>(p1.peer.office_id, "host_telemetry", {}, { dir: dirClient });
      expect(tel.result.slots.gpu_max).toBe(1);

      // 2. Job async que lee archivo de entrada, imprime a stdout y genera artefacto binario de 300 KB
      const inputB64 = Buffer.from("hola-xeon").toString("base64");
      const sub = await call<{ job_id: string }>(
        p1.peer.office_id,
        "job_submit",
        {
          command:
            "cat input.txt && echo ' :: ok' && head -c 307200 /dev/urandom > big.bin",
          files: [{ path: "input.txt", content_b64: inputB64 }],
          gpu: false,
          priority: "below_normal",
        },
        { dir: dirClient },
      );
      const jobId = sub.result.job_id;
      const done = await waitForDone(dirClient, p1.peer.office_id, jobId);
      expect(done.status).toBe("done");
      expect(done.exit_code).toBe(0);
      expect(String(done.stdout_chunk)).toContain("hola-xeon");

      // Aislamiento: peer 2 no puede leer el job de peer 1
      let isoCode = "";
      try {
        await call(p2.peer.office_id, "job_status", { job_id: jobId }, { dir: dirOther });
      } catch (e: unknown) {
        isoCode = (e as { code?: string }).code ?? "";
      }
      expect(isoCode).toBe("no_job");

      // 3. Descarga por chunks (<= 128 KB) y verificación SHA-256
      const parts: Buffer[] = [];
      let offset = 0;
      let expectedSha = "";
      while (true) {
        const chunk = await call<{
          chunk_b64: string;
          next_offset: number;
          eof: boolean;
          sha256: string;
        }>(
          p1.peer.office_id,
          "job_fetch",
          { job_id: jobId, path: "big.bin", offset, limit: 100_000 },
          { dir: dirClient },
        );
        parts.push(Buffer.from(chunk.result.chunk_b64, "base64"));
        expectedSha = chunk.result.sha256;
        offset = chunk.result.next_offset;
        if (chunk.result.eof) break;
      }
      expect(parts.length).toBeGreaterThanOrEqual(3);
      const fullBuf = Buffer.concat(parts);
      expect(fullBuf.length).toBe(307_200);
      const actualSha = crypto.createHash("sha256").update(fullBuf).digest("hex");
      expect(actualSha).toBe(expectedSha);

      // 4. Serialización GPU (maxGpuSlots = 1): 2 jobs GPU no corren simultáneamente
      const g1 = await call<{ job_id: string }>(
        p1.peer.office_id,
        "job_submit",
        { command: "sleep 0.25 && echo g1", gpu: true },
        { dir: dirClient },
      );
      const g2 = await call<{ job_id: string }>(
        p1.peer.office_id,
        "job_submit",
        { command: "echo g2", gpu: true },
        { dir: dirClient },
      );
      const d1 = await waitForDone(dirClient, p1.peer.office_id, g1.result.job_id);
      const d2 = await waitForDone(dirClient, p1.peer.office_id, g2.result.job_id);
      expect(d1.status).toBe("done");
      expect(d2.status).toBe("done");
      expect(Date.parse(String(d2.started_at))).toBeGreaterThanOrEqual(Date.parse(String(d1.finished_at)) - 50);

      // 5. Cancelación mata proceso largo
      const longJob = await call<{ job_id: string }>(
        p1.peer.office_id,
        "job_submit",
        { command: "sleep 30", gpu: false },
        { dir: dirClient },
      );
      await new Promise((r) => setTimeout(r, 120));
      const cancelled = await call<{ status: string }>(
        p1.peer.office_id,
        "job_cancel",
        { job_id: longJob.result.job_id },
        { dir: dirClient },
      );
      expect(cancelled.result.status).toBe("killed");
    } finally {
      server.close();
    }
  });
});
