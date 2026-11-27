import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ComputeQueue } from "../src/compute/queue";
import type { OracleReceipt } from "../src/compute/types";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const peerA = { office_id: "peer-aaa111", name: "linux-victus" };
const peerB = { office_id: "peer-bbb222", name: "other-peer" };

describe("job_upload + win-oracle", () => {
  test("subida por chunks >200KB con SHA-256, montaje en job_submit y oracle-receipt.json", async () => {
    const jobsDir = makeTempDir("isymcp-upload-oracle-");
    const queue = new ComputeQueue({ jobsDir });

    // Archivo binario de 200 KB (2 chunks de 100 KB)
    const payload = crypto.randomBytes(200 * 1024);
    const expectedSha = crypto.createHash("sha256").update(payload).digest("hex");

    const c1 = queue.uploadChunk(
      {
        path: "bin/input.bin",
        offset: 0,
        chunk_b64: payload.subarray(0, 100 * 1024).toString("base64"),
        eof: false,
      },
      peerA,
    );
    expect(c1.upload_id).toMatch(/^upl-/);
    expect(c1.next_offset).toBe(100 * 1024);
    expect(c1.eof).toBe(false);
    expect(c1.sha256).toBeNull();

    const c2 = queue.uploadChunk(
      {
        upload_id: c1.upload_id,
        path: "bin/input.bin",
        offset: c1.next_offset,
        chunk_b64: payload.subarray(100 * 1024).toString("base64"),
        eof: true,
        sha256: expectedSha,
      },
      peerA,
    );
    expect(c2.upload_id).toBe(c1.upload_id);
    expect(c2.size).toBe(payload.length);
    expect(c2.eof).toBe(true);
    expect(c2.sha256).toBe(expectedSha);

    const script = [
      'const fs = require("node:fs");',
      'const data = fs.readFileSync("bin/input.bin");',
      'fs.writeFileSync("out.txt", "len=" + data.length);',
      'console.log("ok:" + data.length);',
    ].join(" ");

    const job = await queue.submit(
      {
        argv: [process.execPath, "-e", script],
        target: process.platform === "win32" ? "win" : "posix",
        upload_id: c1.upload_id,
        oracle: true,
        label: "oracle-test",
      },
      peerA,
    );

    // Esperar a que termine
    const deadline = Date.now() + 15_000;
    let st = queue.status(job.job_id, peerA.office_id);
    while ((st.status === "queued" || st.status === "running") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      st = queue.status(job.job_id, peerA.office_id);
    }

    expect(st.status).toBe("done");
    expect(st.exit_code).toBe(0);
    expect(st.stdout_chunk).toContain(`ok:${payload.length}`);

    // Staging consumido por defecto
    expect(fs.existsSync(path.join(jobsDir, "_uploads", c1.upload_id))).toBe(false);

    // Leer oracle-receipt.json vía fetchArtifact
    const fetched = queue.fetchArtifact(job.job_id, peerA.office_id, "oracle-receipt.json");
    const receipt = JSON.parse(Buffer.from(fetched.chunk_b64, "base64").toString("utf8")) as OracleReceipt;

    expect(receipt.schema).toBe("win-oracle-receipt@1");
    expect(receipt.job_id).toBe(job.job_id);
    expect(receipt.exit_code).toBe(0);
    expect(receipt.timed_out).toBe(false);
    expect(receipt.killed).toBe(false);
    expect(receipt.duration_ms).toBeGreaterThanOrEqual(0);
    expect(receipt.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.stderr_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.os_version.length).toBeGreaterThan(0);
    expect(receipt.arch).toBe(process.arch);

    const inputArt = receipt.artifacts.find((a) => a.path === "bin/input.bin");
    const outArt = receipt.artifacts.find((a) => a.path === "out.txt");
    expect(inputArt?.size).toBe(payload.length);
    expect(inputArt?.sha256).toBe(expectedSha);
    expect(outArt?.size).toBe(`len=${payload.length}`.length);
    expect(receipt.artifacts.some((a) => a.path === "oracle-receipt.json")).toBe(false);
  });

  test("rechaza path traversal, sha256 mismatch y aislamiento entre peers", () => {
    const jobsDir = makeTempDir("isymcp-upload-sec-");
    const queue = new ComputeQueue({ jobsDir });

    expect(() =>
      queue.uploadChunk(
        { path: "../escape.txt", chunk_b64: Buffer.from("x").toString("base64"), eof: true },
        peerA,
      ),
    ).toThrow(/path traversal/);

    expect(() =>
      queue.uploadChunk(
        {
          path: "bad.bin",
          chunk_b64: Buffer.from("hello").toString("base64"),
          eof: true,
          sha256: "0".repeat(64),
        },
        peerA,
      ),
    ).toThrow(/sha256 mismatch/);

    const ok = queue.uploadChunk(
      { path: "ok.txt", chunk_b64: Buffer.from("secret").toString("base64"), eof: true },
      peerA,
    );

    expect(() =>
      queue.uploadChunk(
        { upload_id: ok.upload_id, path: "ok.txt", chunk_b64: Buffer.from("x").toString("base64"), eof: true },
        peerB,
      ),
    ).toThrow(/no pertenece|no existe/);
  });
});
