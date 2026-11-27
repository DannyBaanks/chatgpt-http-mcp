// src/compute/queue.ts — Cola persistente de trabajos async con semáforos GPU/CPU,
// streaming incremental de logs, descarga de artefactos por bloques (SHA-256) y aislamiento por peer.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bridgeHome } from "../codex-sessions";
import { hostCapacity, LinkError, type LinkPeer } from "../link/crypto";
import type { ComputeRpcHandler } from "../link/server";
import { stopProcessTree } from "../platform/process";
import { getComputeExecutor, readHostGpuTelemetry, resolveComputeTarget } from "./executor";
import type {
  ComputeJobRecord,
  ComputeJobSubmitInput,
  ComputePriority,
  ComputeRunningHandle,
} from "./types";

const MAX_FETCH_CHUNK = 128 * 1024; // cabe con holgura en MAX_BODY (256 KB) tras base64 + sobre
const MAX_LOG_CHUNK = 64 * 1024;
const MAX_INPUT_FILES = 32;
const MAX_INPUT_FILE_BYTES = 180 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 horas
const DEFAULT_MAX_LOG_BYTES = 32 * 1024 * 1024; // 32 MiB por stream
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const DEFAULT_MAX_RETAINED_JOBS = 200;

function isTerminalStatus(status: ComputeJobRecord["status"]): boolean {
  return status === "done" || status === "failed" || status === "killed" || status === "timed_out";
}

function killOrphanPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  stopProcessTree(pid);
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ya detenido */
      }
    }
  }
}

export interface ComputeQueueOptions {
  jobsDir?: string;
  maxGpuSlots?: number;
  maxCpuSlots?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxLogBytes?: number;
  retentionMs?: number;
  maxRetainedJobs?: number;
}

export function defaultComputeJobsDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.ISYMCP_COMPUTE_DIR;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  return path.join(bridgeHome(env), "compute-jobs");
}

function safeSubPath(baseDir: string, rel: string): string {
  if (!rel || typeof rel !== "string" || path.isAbsolute(rel)) {
    throw new LinkError("bad_args", `ruta relativa inválida: ${rel}`);
  }
  const normalized = rel.replaceAll("\\", "/");
  const full = path.resolve(baseDir, normalized);
  const diff = path.relative(baseDir, full);
  if (diff.startsWith("..") || path.isAbsolute(diff)) {
    throw new LinkError("bad_path", `path traversal bloqueado: ${rel}`, 400);
  }
  return full;
}

function listWorkFiles(workDir: string, prefix = ""): Array<{ path: string; size: number }> {
  if (!fs.existsSync(workDir)) return [];
  const out: Array<{ path: string; size: number }> = [];
  for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(workDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listWorkFiles(full, rel));
    } else if (entry.isFile()) {
      try {
        out.push({ path: rel, size: fs.statSync(full).size });
      } catch {
        /* ignore */
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function readSlice(filePath: string, offset: number, maxBytes: number): { text: string; next_offset: number; size: number } {
  if (!fs.existsSync(filePath)) return { text: "", next_offset: 0, size: 0 };
  const size = fs.statSync(filePath).size;
  const start = Math.max(0, Math.min(offset, size));
  const len = Math.max(0, Math.min(maxBytes, size - start));
  if (len === 0) return { text: "", next_offset: start, size };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }
  return { text: buf.toString("utf8"), next_offset: start + len, size };
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(64 * 1024);
  try {
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export class ComputeQueue {
  readonly jobsDir: string;
  readonly maxGpuSlots: number;
  readonly maxCpuSlots: number;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly maxLogBytes: number;
  readonly retentionMs: number;
  readonly maxRetainedJobs: number;

  private gpuPaused = false;
  private runningGpu = 0;
  private runningCpu = 0;
  private queue: string[] = [];
  private jobs = new Map<string, ComputeJobRecord>();
  private running = new Map<string, ComputeRunningHandle>();
  private pendingEnv = new Map<string, Record<string, string> | undefined>();
  private shaCache = new Map<string, string>();

  constructor(opts: ComputeQueueOptions = {}) {
    this.jobsDir = opts.jobsDir ?? defaultComputeJobsDir();
    this.maxGpuSlots = Math.max(1, opts.maxGpuSlots ?? 1);
    this.maxCpuSlots = Math.max(1, opts.maxCpuSlots ?? Math.max(1, os.cpus().length - 2));
    this.maxTimeoutMs = Math.max(1000, opts.maxTimeoutMs ?? MAX_TIMEOUT_MS);
    this.defaultTimeoutMs = Math.min(this.maxTimeoutMs, Math.max(1000, opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxLogBytes = Math.max(1024, opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES);
    this.retentionMs = Math.max(1000, opts.retentionMs ?? DEFAULT_RETENTION_MS);
    this.maxRetainedJobs = Math.max(1, opts.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS);
    fs.mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    this.loadExisting();
    this.pruneOldJobs();
  }

  private jobDir(jobId: string): string {
    return path.join(this.jobsDir, jobId);
  }

  private metaPath(jobId: string): string {
    return path.join(this.jobDir(jobId), "meta.json");
  }

  private saveMeta(rec: ComputeJobRecord): void {
    const dir = this.jobDir(rec.job_id);
    fs.mkdirSync(dir, { recursive: true });
    const p = this.metaPath(rec.job_id);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, p);
  }

  private loadExisting(): void {
    if (!fs.existsSync(this.jobsDir)) return;
    for (const entry of fs.readdirSync(this.jobsDir)) {
      const p = path.join(this.jobsDir, entry, "meta.json");
      if (!fs.existsSync(p)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(p, "utf8")) as ComputeJobRecord;
        if (rec && rec.job_id) {
          if (rec.status === "running" || rec.status === "queued") {
            if (rec.status === "running" && typeof rec.pid === "number" && rec.pid > 0) {
              killOrphanPid(rec.pid);
            }
            rec.pid = null;
            rec.status = "failed";
            rec.error = "interrupted_by_restart";
            rec.finished_at = new Date().toISOString();
            this.saveMeta(rec);
          }
          this.jobs.set(rec.job_id, rec);
        }
      } catch {
        /* ignore corrupt meta */
      }
    }
  }

  pruneOldJobs(nowMs = Date.now()): number {
    const terminal = [...this.jobs.values()]
      .filter((j) => isTerminalStatus(j.status))
      .sort((a, b) => {
        const ta = Date.parse(a.finished_at ?? a.created_at) || 0;
        const tb = Date.parse(b.finished_at ?? b.created_at) || 0;
        return ta - tb; // más viejos primero
      });

    let removed = 0;
    const toRemove = new Set<string>();
    for (const j of terminal) {
      const ts = Date.parse(j.finished_at ?? j.created_at) || 0;
      if (ts > 0 && nowMs - ts > this.retentionMs) {
        toRemove.add(j.job_id);
      }
    }
    const remaining = terminal.filter((j) => !toRemove.has(j.job_id));
    if (remaining.length > this.maxRetainedJobs) {
      const excess = remaining.length - this.maxRetainedJobs;
      for (let i = 0; i < excess; i++) {
        toRemove.add(remaining[i]!.job_id);
      }
    }

    for (const jobId of toRemove) {
      this.jobs.delete(jobId);
      for (const k of this.shaCache.keys()) {
        if (k.startsWith(`${jobId}:`)) this.shaCache.delete(k);
      }
      try {
        fs.rmSync(this.jobDir(jobId), { recursive: true, force: true });
        removed++;
      } catch {
        /* best effort */
      }
    }
    return removed;
  }

  setGpuPaused(paused: boolean): void {
    this.gpuPaused = paused;
    if (!paused) this.pump();
  }

  isGpuPaused(): boolean {
    return this.gpuPaused;
  }

  async telemetry() {
    const gpu = await readHostGpuTelemetry();
    return {
      host: hostCapacity(),
      gpu,
      slots: {
        gpu_max: this.maxGpuSlots,
        gpu_busy: this.runningGpu,
        gpu_paused: this.gpuPaused,
        cpu_max: this.maxCpuSlots,
        cpu_busy: this.runningCpu,
        queued: this.queue.length,
      },
    };
  }

  async submit(input: ComputeJobSubmitInput, peer: Pick<LinkPeer, "office_id" | "name">): Promise<ComputeJobRecord> {
    const hasArgv = Array.isArray(input.argv) && input.argv.length > 0 && input.argv.every((x) => typeof x === "string");
    const hasCmd = typeof input.command === "string" && input.command.trim().length > 0;
    if (!hasArgv && !hasCmd) {
      throw new LinkError("bad_args", "job_submit requiere `argv` o `command`");
    }

    const target = await resolveComputeTarget(input.target ?? "auto");
    const exec = await getComputeExecutor(target);
    if (!exec || !(await exec.isAvailable())) {
      throw new LinkError("target_unavailable", `el target «${target}» no está disponible en este host`, 503);
    }

    const priority: ComputePriority =
      input.priority === "idle" || input.priority === "normal" || input.priority === "below_normal"
        ? input.priority
        : "below_normal";

    const jobId = `job-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const dir = this.jobDir(jobId);
    const workDir = path.join(dir, "work");
    let cwd: string;
    try {
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(path.join(dir, "stdout.log"), "", "utf8");
      fs.writeFileSync(path.join(dir, "stderr.log"), "", "utf8");

      if (Array.isArray(input.files) && input.files.length > 0) {
        if (input.files.length > MAX_INPUT_FILES) {
          throw new LinkError("too_many_files", `máximo ${MAX_INPUT_FILES} archivos de entrada por job`);
        }
        for (const f of input.files) {
          const dest = safeSubPath(workDir, f.path);
          const buf = Buffer.from(String(f.content_b64 || ""), "base64");
          if (buf.length > MAX_INPUT_FILE_BYTES) {
            throw new LinkError("file_too_big", `archivo de entrada excede ${MAX_INPUT_FILE_BYTES} bytes: ${f.path}`, 413);
          }
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, buf);
        }
      }

      cwd =
        typeof input.cwd === "string" && input.cwd.trim()
          ? path.isAbsolute(input.cwd.trim())
            ? input.cwd.trim()
            : safeSubPath(workDir, input.cwd.trim())
          : workDir;
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }

    const rawTimeout = Number(input.timeout_ms);
    const timeoutMs =
      Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(this.maxTimeoutMs, Math.max(1000, Math.floor(rawTimeout)))
        : this.defaultTimeoutMs;

    const rec: ComputeJobRecord = {
      job_id: jobId,
      owner_office_id: peer.office_id,
      owner_name: peer.name,
      label: typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 120) : (hasCmd ? input.command!.slice(0, 80) : input.argv!.join(" ").slice(0, 80)),
      target,
      wsl_distro: typeof input.wsl_distro === "string" ? input.wsl_distro : undefined,
      gpu: input.gpu === true,
      priority,
      argv: hasArgv ? input.argv : undefined,
      command: hasCmd ? input.command : undefined,
      cwd,
      status: "queued",
      pid: null,
      exit_code: null,
      signal: null,
      error: null,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      timeout_ms: timeoutMs,
    };

    this.jobs.set(jobId, rec);
    this.pendingEnv.set(jobId, input.env);
    this.saveMeta(rec);
    this.queue.push(jobId);
    this.pump();
    return { ...rec };
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length; ) {
      const jobId = this.queue[i]!;
      const rec = this.jobs.get(jobId);
      if (!rec || rec.status !== "queued") {
        this.queue.splice(i, 1);
        continue;
      }
      if (rec.gpu) {
        if (this.gpuPaused || this.runningGpu >= this.maxGpuSlots) {
          i++;
          continue;
        }
      } else if (this.runningCpu >= this.maxCpuSlots) {
        i++;
        continue;
      }

      this.queue.splice(i, 1);
      if (rec.gpu) this.runningGpu++;
      else this.runningCpu++;
      void this.launch(rec);
    }
  }

  private async launch(rec: ComputeJobRecord): Promise<void> {
    const releaseSlot = () => {
      if (rec.gpu) this.runningGpu = Math.max(0, this.runningGpu - 1);
      else this.runningCpu = Math.max(0, this.runningCpu - 1);
      this.pump();
    };

    try {
      const exec = await getComputeExecutor(rec.target);
      if (!exec) throw new Error(`executor_missing:${rec.target}`);

      rec.status = "running";
      rec.started_at = new Date().toISOString();
      this.saveMeta(rec);

      const dir = this.jobDir(rec.job_id);
      const env = this.pendingEnv.get(rec.job_id);
      this.pendingEnv.delete(rec.job_id);

      const handle = await exec.spawn({
        job_id: rec.job_id,
        job_dir: dir,
        cwd: rec.cwd,
        argv: rec.argv,
        command: rec.command,
        target: rec.target,
        wsl_distro: rec.wsl_distro,
        priority: rec.priority,
        env,
        timeout_ms: rec.timeout_ms,
        max_log_bytes: this.maxLogBytes,
        stdout_path: path.join(dir, "stdout.log"),
        stderr_path: path.join(dir, "stderr.log"),
      });

      rec.pid = handle.pid;
      this.running.set(rec.job_id, handle);
      this.saveMeta(rec);

      const outcome = await handle.done;
      this.running.delete(rec.job_id);
      rec.exit_code = outcome.exit_code;
      rec.signal = outcome.signal;
      rec.error = outcome.error ?? null;
      rec.finished_at = new Date().toISOString();
      if (outcome.timed_out) rec.status = "timed_out";
      else if (outcome.killed) rec.status = "killed";
      else if (outcome.exit_code === 0 && !outcome.error) rec.status = "done";
      else rec.status = "failed";
      this.saveMeta(rec);
    } catch (err) {
      this.running.delete(rec.job_id);
      rec.status = "failed";
      rec.error = err instanceof Error ? err.message : String(err);
      rec.finished_at = new Date().toISOString();
      this.saveMeta(rec);
    } finally {
      this.pruneOldJobs();
      releaseSlot();
    }
  }

  private ownJob(jobId: string, peerOfficeId: string): ComputeJobRecord {
    const rec = this.jobs.get(jobId);
    if (!rec || rec.owner_office_id !== peerOfficeId) {
      throw new LinkError("no_job", "ese job no existe o no pertenece a este peer", 404);
    }
    return rec;
  }

  status(
    jobId: string,
    peerOfficeId: string,
    opts: { stdout_offset?: number; stderr_offset?: number; max_bytes?: number } = {},
  ) {
    const rec = this.ownJob(jobId, peerOfficeId);
    const dir = this.jobDir(jobId);
    const limit = Math.min(Math.max(1024, Number(opts.max_bytes ?? 32_768) || 32_768), MAX_LOG_CHUNK);
    const out = readSlice(path.join(dir, "stdout.log"), Number(opts.stdout_offset ?? 0) || 0, limit);
    const err = readSlice(path.join(dir, "stderr.log"), Number(opts.stderr_offset ?? 0) || 0, limit);
    const artifacts = listWorkFiles(path.join(dir, "work"));
    return {
      ...rec,
      stdout_chunk: out.text,
      stderr_chunk: err.text,
      next_stdout_offset: out.next_offset,
      next_stderr_offset: err.next_offset,
      stdout_size: out.size,
      stderr_size: err.size,
      artifacts,
    };
  }

  list(peerOfficeId: string, limit = 50): ComputeJobRecord[] {
    return [...this.jobs.values()]
      .filter((j) => j.owner_office_id === peerOfficeId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  async cancel(jobId: string, peerOfficeId: string): Promise<{ job_id: string; status: ComputeJobRecord["status"] }> {
    const rec = this.ownJob(jobId, peerOfficeId);
    const qIdx = this.queue.indexOf(jobId);
    if (qIdx >= 0) {
      this.queue.splice(qIdx, 1);
      this.pendingEnv.delete(jobId);
      rec.status = "killed";
      rec.finished_at = new Date().toISOString();
      this.saveMeta(rec);
      return { job_id: rec.job_id, status: rec.status };
    }
    const handle = this.running.get(jobId);
    if (handle) {
      await handle.cancel();
      await handle.done;
    }
    return { job_id: rec.job_id, status: rec.status };
  }

  fetchArtifact(
    jobId: string,
    peerOfficeId: string,
    relPath: string,
    opts: { offset?: number; limit?: number } = {},
  ) {
    const rec = this.ownJob(jobId, peerOfficeId);
    const workDir = path.join(this.jobDir(jobId), "work");
    const full = safeSubPath(workDir, relPath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw new LinkError("not_found", `artefacto no encontrado: ${relPath}`, 404);
    }
    const st = fs.statSync(full);
    const size = st.size;
    const offset = Math.max(0, Math.min(Number(opts.offset ?? 0) || 0, size));
    const limit = Math.max(1, Math.min(Number(opts.limit ?? MAX_FETCH_CHUNK) || MAX_FETCH_CHUNK, MAX_FETCH_CHUNK));
    const len = Math.max(0, Math.min(limit, size - offset));
    const buf = Buffer.alloc(len);
    if (len > 0) {
      const fd = fs.openSync(full, "r");
      try {
        fs.readSync(fd, buf, 0, len, offset);
      } finally {
        fs.closeSync(fd);
      }
    }
    const nextOffset = offset + len;
    let sha256: string | null = null;
    if (isTerminalStatus(rec.status)) {
      const cacheKey = `${jobId}:${relPath}:${size}:${st.mtimeMs}`;
      const cached = this.shaCache.get(cacheKey);
      if (cached) {
        sha256 = cached;
      } else {
        sha256 = sha256File(full);
        this.shaCache.set(cacheKey, sha256);
      }
    }
    return {
      job_id: jobId,
      path: relPath,
      offset,
      next_offset: nextOffset,
      size,
      eof: nextOffset >= size,
      sha256,
      chunk_b64: buf.toString("base64"),
    };
  }
}

export function createComputeRpcHandler(queue: ComputeQueue): ComputeRpcHandler {
  return async (op, args, peer) => {
    switch (op) {
      case "host_telemetry":
        return queue.telemetry();
      case "job_submit":
        return queue.submit(args as unknown as ComputeJobSubmitInput, peer);
      case "job_status":
        return queue.status(String(args.job_id ?? ""), peer.office_id, {
          stdout_offset: Number(args.stdout_offset ?? 0),
          stderr_offset: Number(args.stderr_offset ?? 0),
          max_bytes: Number(args.max_bytes ?? 32_768),
        });
      case "job_list":
        return { jobs: queue.list(peer.office_id, Number(args.limit ?? 50)) };
      case "job_cancel":
        return queue.cancel(String(args.job_id ?? ""), peer.office_id);
      case "job_fetch":
        return queue.fetchArtifact(String(args.job_id ?? ""), peer.office_id, String(args.path ?? ""), {
          offset: Number(args.offset ?? 0),
          limit: Number(args.limit ?? MAX_FETCH_CHUNK),
        });
      default:
        throw new LinkError("bad_op", `operación compute desconocida: ${op}`);
    }
  };
}
