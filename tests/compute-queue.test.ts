import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSafeJobEnv } from "../src/compute/env";
import { getComputeExecutor, registerComputeExecutor } from "../src/compute/executor";
import { ComputeQueue, createComputeRpcHandler } from "../src/compute/queue";
import type { ComputeExecRequest, ComputeRunningHandle, PlatformComputeExecutor } from "../src/compute/types";
import { createLinkServer } from "../src/link/server";
import { acceptPending, call, requestPair, trustPeer } from "../src/link/client";
import { setPeerComputeAuthority } from "../src/link/authority";
import { stopProcessTree } from "../src/platform/process";

const cleanupDirs: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

// En CI Windows (windows-latest) antes de integrar M3b (`exec-win.ts`), registramos
// un ejecutor mínimo portable solo para que la suite de ComputeQueue valide la cola en win32.
beforeAll(async () => {
  if (process.platform === "win32" && !(await getComputeExecutor("win"))) {
    const portableWinExec: PlatformComputeExecutor = {
      target: "win",
      async isAvailable() {
        return true;
      },
      async spawn(req: ComputeExecRequest): Promise<ComputeRunningHandle> {
        const out = createWriteStream(req.stdout_path, { flags: "a" });
        const err = createWriteStream(req.stderr_path, { flags: "a" });
        const [bin, args] =
          req.argv && req.argv.length > 0
            ? [req.argv[0]!, req.argv.slice(1)]
            : ["cmd.exe", ["/d", "/s", "/c", req.command ?? ""]];
        const child = spawn(bin, args, {
          cwd: req.cwd,
          env: buildSafeJobEnv(req.env),
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.pipe(out);
        child.stderr?.pipe(err);
        const pid = child.pid ?? 0;
        let killed = false;
        let timedOut = false;
        const cancel = async () => {
          killed = true;
          stopProcessTree(pid);
        };
        const timer =
          req.timeout_ms && req.timeout_ms > 0
            ? setTimeout(() => {
                timedOut = true;
                void cancel();
              }, req.timeout_ms)
            : null;
        const done = new Promise<Awaited<ComputeRunningHandle["done"]>>((resolve) => {
          child.once("close", (code, signal) => {
            if (timer) clearTimeout(timer);
            out.end();
            err.end();
            resolve({ exit_code: code, signal: signal ?? null, timed_out: timedOut, killed: killed && !timedOut });
          });
        });
        return { pid, cancel, done };
      },
    };
    registerComputeExecutor(portableWinExec);
  }
});

async function waitForDone(
  dirClient: string,
  peerId: string,
  jobId: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await call<Record<string, unknown>>(peerId, "job_status", { job_id: jobId }, { dir: dirClient });
    const st = String(r.result.status);
    if (st !== "queued" && st !== "running") return r.result;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`timeout waiting for ${jobId}`);
}

async function setupPairedHost(queueOpts: ConstructorParameters<typeof ComputeQueue>[0] = {}) {
  const dirClient = makeTmp("isymcp-comp-cli-");
  const dirOther = makeTmp("isymcp-comp-other-");
  const dirHost = makeTmp("isymcp-comp-host-");
  const queue = new ComputeQueue({ jobsDir: join(dirHost, "jobs"), maxGpuSlots: 1, maxCpuSlots: 2, ...queueOpts });

  const { server } = createLinkServer({
    dir: dirHost,
    hiveRoot: null,
    computeHandler: createComputeRpcHandler(queue),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = `127.0.0.1:${(server.address() as AddressInfo).port}`;

  const p1 = await requestPair(addr, { dir: dirClient, port: 47831 });
  const acc1 = acceptPending(p1.code, dirHost)!;
  trustPeer(p1.peer, dirClient);
  setPeerComputeAuthority(acc1.office_id, true, dirHost);

  const p2 = await requestPair(addr, { dir: dirOther, port: 47831 });
  const acc2 = acceptPending(p2.code, dirHost)!;
  trustPeer(p2.peer, dirOther);
  setPeerComputeAuthority(acc2.office_id, true, dirHost);

  return {
    dirClient,
    dirOther,
    dirHost,
    queue,
    server,
    peer1Id: p1.peer.office_id,
    peer2Id: p2.peer.office_id,
  };
}

describe("ComputeQueue + Link RPC (seguridad, slots GPU, aislamiento, huérfanos, límites)", () => {
  test("ejecución async, entorno mínimo sin secretos del host, chunked fetch >300KB con SHA-256", async () => {
    const prevSecret = process.env.ISYMCP_TEST_HOST_SENTINEL;
    process.env.ISYMCP_TEST_HOST_SENTINEL = "sentinel_host_env_must_not_leak_42";
    const env = await setupPairedHost();

    try {
      const tel = await call<{ slots: { gpu_max: number } }>(env.peer1Id, "host_telemetry", {}, { dir: env.dirClient });
      expect(tel.result.slots.gpu_max).toBe(1);

      const inputB64 = Buffer.from("hola-xeon").toString("base64");
      const script = [
        'const fs = require("node:fs");',
        'const crypto = require("node:crypto");',
        'const txt = fs.readFileSync("input.txt", "utf8");',
        'console.log(txt + " :: leaked=" + (process.env.ISYMCP_TEST_HOST_SENTINEL || "NONE") + " :: custom=" + (process.env.JOB_CUSTOM || ""));',
        'fs.writeFileSync("big.bin", crypto.randomBytes(307200));',
      ].join(" ");

      const sub = await call<{ job_id: string }>(
        env.peer1Id,
        "job_submit",
        {
          argv: [process.execPath, "-e", script],
          files: [{ path: "input.txt", content_b64: inputB64 }],
          env: { JOB_CUSTOM: "ok-123" },
          gpu: false,
          priority: "below_normal",
        },
        { dir: env.dirClient },
      );

      const done = await waitForDone(env.dirClient, env.peer1Id, sub.result.job_id);
      expect(done.status).toBe("done");
      expect(done.exit_code).toBe(0);
      expect(String(done.stdout_chunk)).toContain("hola-xeon :: leaked=NONE :: custom=ok-123");

      // Descarga por chunks (<= 128 KB) y verificación SHA-256 consistente/cacheada
      const parts: Buffer[] = [];
      let offset = 0;
      const shas = new Set<string>();
      while (true) {
        const chunk = await call<{
          chunk_b64: string;
          next_offset: number;
          eof: boolean;
          sha256: string | null;
        }>(
          env.peer1Id,
          "job_fetch",
          { job_id: sub.result.job_id, path: "big.bin", offset, limit: 100_000 },
          { dir: env.dirClient },
        );
        parts.push(Buffer.from(chunk.result.chunk_b64, "base64"));
        expect(typeof chunk.result.sha256).toBe("string");
        shas.add(chunk.result.sha256!);
        offset = chunk.result.next_offset;
        if (chunk.result.eof) break;
      }
      expect(parts.length).toBeGreaterThanOrEqual(3);
      expect(shas.size).toBe(1);
      const fullBuf = Buffer.concat(parts);
      expect(fullBuf.length).toBe(307_200);
      const actualSha = crypto.createHash("sha256").update(fullBuf).digest("hex");
      expect(actualSha).toBe([...shas][0]);
    } finally {
      env.server.close();
      if (prevSecret === undefined) delete process.env.ISYMCP_TEST_HOST_SENTINEL;
      else process.env.ISYMCP_TEST_HOST_SENTINEL = prevSecret;
    }
  });

  test("aislamiento estricto entre dos peers en status, list, cancel y fetch", async () => {
    const env = await setupPairedHost();
    try {
      const sub = await call<{ job_id: string }>(
        env.peer1Id,
        "job_submit",
        {
          argv: [process.execPath, "-e", 'require("node:fs").writeFileSync("secret.txt", "peer1-only");'],
          gpu: false,
        },
        { dir: env.dirClient },
      );
      const jobId = sub.result.job_id;
      await waitForDone(env.dirClient, env.peer1Id, jobId);

      // Peer 2 no ve el job en job_list
      const list2 = await call<{ jobs: Array<{ job_id: string }> }>(
        env.peer2Id,
        "job_list",
        {},
        { dir: env.dirOther },
      );
      expect(list2.result.jobs.some((j) => j.job_id === jobId)).toBe(false);

      // Peer 2 recibe no_job en status, cancel y fetch
      for (const [op, args] of [
        ["job_status", { job_id: jobId }],
        ["job_cancel", { job_id: jobId }],
        ["job_fetch", { job_id: jobId, path: "secret.txt" }],
      ] as const) {
        let code = "";
        try {
          await call(env.peer2Id, op, args, { dir: env.dirOther });
        } catch (e: unknown) {
          code = (e as { code?: string }).code ?? "";
        }
        expect(code).toBe("no_job");
      }
    } finally {
      env.server.close();
    }
  });

  test("serialización GPU (maxGpuSlots = 1): dos jobs GPU corren uno tras otro sin solaparse", async () => {
    const env = await setupPairedHost({ maxGpuSlots: 1 });
    try {
      const g1 = await call<{ job_id: string }>(
        env.peer1Id,
        "job_submit",
        { argv: [process.execPath, "-e", "setTimeout(() => console.log('g1'), 220)"], gpu: true },
        { dir: env.dirClient },
      );
      const g2 = await call<{ job_id: string }>(
        env.peer1Id,
        "job_submit",
        { argv: [process.execPath, "-e", "console.log('g2')"], gpu: true },
        { dir: env.dirClient },
      );
      const d1 = await waitForDone(env.dirClient, env.peer1Id, g1.result.job_id);
      const d2 = await waitForDone(env.dirClient, env.peer1Id, g2.result.job_id);
      expect(d1.status).toBe("done");
      expect(d2.status).toBe("done");
      expect(Date.parse(String(d2.started_at))).toBeGreaterThanOrEqual(Date.parse(String(d1.finished_at)) - 50);
    } finally {
      env.server.close();
    }
  });

  test("límites: clamp de timeout_ms, truncado de stdout, limpieza en archivo grande y sha256=null mientras corre", async () => {
    const env = await setupPairedHost({ defaultTimeoutMs: 5000, maxTimeoutMs: 10_000, maxLogBytes: 2048 });
    try {
      // 1. Archivo de entrada demasiado grande (>180 KB, pero cabe en sobre 256 KB) no deja directorio huérfano sin meta.json
      const bigB64 = Buffer.alloc(185 * 1024, 65).toString("base64");
      let errCode = "";
      try {
        await env.queue.submit(
          {
            argv: [process.execPath, "-e", "console.log('never')"],
            files: [{ path: "too-big.bin", content_b64: bigB64 }],
          },
          { office_id: env.peer1Id, name: "peer1" },
        );
      } catch (e: unknown) {
        errCode = (e as { code?: string }).code ?? "";
      }
      expect(errCode).toBe("file_too_big");
      expect(readdirSync(join(env.dirHost, "jobs"))).toEqual([]);

      // 2. timeout_ms excesivo se clampea a maxTimeoutMs
      const clamped = await call<{ job_id: string; timeout_ms: number }>(
        env.peer1Id,
        "job_submit",
        { argv: [process.execPath, "-e", "console.log('A'.repeat(6000))"], timeout_ms: 999_999_999 },
        { dir: env.dirClient },
      );
      expect(clamped.result.timeout_ms).toBe(10_000);
      const done = await waitForDone(env.dirClient, env.peer1Id, clamped.result.job_id);
      expect(done.status).toBe("done");
      if (process.platform !== "win32") {
        expect(String(done.stdout_chunk)).toContain("[isymcp] output truncated at 2048 bytes");
      }

      // 3. Mientras el job corre, fetchArtifact devuelve sha256: null (sin recalcular ni mentir)
      const liveJob = await call<{ job_id: string }>(
        env.peer1Id,
        "job_submit",
        {
          argv: [
            process.execPath,
            "-e",
            'require("node:fs").writeFileSync("partial.txt", "abc"); setTimeout(() => {}, 5000);',
          ],
        },
        { dir: env.dirClient },
      );
      let fetchedLive: { sha256: string | null } | null = null;
      for (let i = 0; i < 40; i++) {
        try {
          const f = await call<{ sha256: string | null }>(
            env.peer1Id,
            "job_fetch",
            { job_id: liveJob.result.job_id, path: "partial.txt" },
            { dir: env.dirClient },
          );
          fetchedLive = f.result;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 40));
        }
      }
      expect(fetchedLive).not.toBeNull();
      expect(fetchedLive!.sha256).toBeNull();
      await call(env.peer1Id, "job_cancel", { job_id: liveJob.result.job_id }, { dir: env.dirClient });
    } finally {
      env.server.close();
    }
  });

  test.skipIf(process.platform === "win32")(
    "cancelación mata al proceso nieto (tree-kill real en POSIX)",
    async () => {
      const env = await setupPairedHost();
      try {
        const sub = await call<{ job_id: string }>(
          env.peer1Id,
          "job_submit",
          { command: "sleep 30 & echo $! > child.pid; wait" },
          { dir: env.dirClient },
        );
        const pidFile = join(env.dirHost, "jobs", sub.result.job_id, "work", "child.pid");
        let childPid = 0;
        for (let i = 0; i < 50; i++) {
          if (existsSync(pidFile)) {
            const raw = readFileSync(pidFile, "utf8").trim();
            if (/^\d+$/.test(raw)) {
              childPid = Number(raw);
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 40));
        }
        expect(childPid).toBeGreaterThan(0);

        const cancelled = await call<{ status: string }>(
          env.peer1Id,
          "job_cancel",
          { job_id: sub.result.job_id },
          { dir: env.dirClient },
        );
        expect(cancelled.result.status).toBe("killed");

        await new Promise((r) => setTimeout(r, 120));
        let alive = true;
        try {
          process.kill(childPid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      } finally {
        env.server.close();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "reinicio del servidor mata procesos huérfanos en estado running para liberar GPU/slots",
    async () => {
      const jobsDir = makeTmp("isymcp-orphan-jobs-");
      const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
      orphan.unref();
      const orphanPid = orphan.pid!;
      expect(orphanPid).toBeGreaterThan(0);

      const jobDir = join(jobsDir, "job-orphan-1");
      mkdirSync(join(jobDir, "work"), { recursive: true });
      writeFileSync(
        join(jobDir, "meta.json"),
        JSON.stringify({
          job_id: "job-orphan-1",
          owner_office_id: "peer-a",
          owner_name: "peer-a",
          label: "orphan",
          target: "posix",
          gpu: true,
          priority: "below_normal",
          cwd: join(jobDir, "work"),
          status: "running",
          pid: orphanPid,
          exit_code: null,
          signal: null,
          error: null,
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          finished_at: null,
        }),
        "utf8",
      );

      // Al instanciar ComputeQueue, loadExisting() debe matar el huérfano y limpiar el registro
      const q = new ComputeQueue({ jobsDir });
      const st = q.status("job-orphan-1", "peer-a");
      expect(st.status).toBe("failed");
      expect(st.error).toBe("interrupted_by_restart");
      expect(st.pid).toBeNull();

      await new Promise((r) => setTimeout(r, 120));
      let alive = true;
      try {
        process.kill(orphanPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
  );
});
