// src/compute/exec-posix.ts — Ejecutor nativo POSIX (Linux/macOS) con nice, timeout y tree-kill.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { stopProcessTree } from "../platform/process";
import type { ComputeExecRequest, ComputePriority, ComputeRunningHandle, PlatformComputeExecutor } from "./types";

function niceDelta(priority: ComputePriority): number {
  if (priority === "idle") return 15;
  if (priority === "below_normal") return 10;
  return 0;
}

export const posixComputeExecutor: PlatformComputeExecutor = {
  target: "posix",
  async isAvailable(): Promise<boolean> {
    return process.platform !== "win32";
  },
  async spawn(req: ComputeExecRequest): Promise<ComputeRunningHandle> {
    const outStream = createWriteStream(req.stdout_path, { flags: "a" });
    const errStream = createWriteStream(req.stderr_path, { flags: "a" });

    let bin: string;
    let args: string[];
    const delta = niceDelta(req.priority);

    if (req.argv && req.argv.length > 0) {
      if (delta > 0) {
        bin = "nice";
        args = ["-n", String(delta), ...req.argv];
      } else {
        bin = req.argv[0]!;
        args = req.argv.slice(1);
      }
    } else if (req.command && req.command.trim()) {
      const shell = process.env.SHELL && process.env.SHELL.includes("sh") ? "/bin/bash" : "/bin/sh";
      if (delta > 0) {
        bin = "nice";
        args = ["-n", String(delta), shell, "-lc", req.command];
      } else {
        bin = shell;
        args = ["-lc", req.command];
      }
    } else {
      outStream.end();
      errStream.end();
      throw new Error("compute_missing_command_or_argv");
    }

    const child = spawn(bin, args, {
      cwd: req.cwd,
      env: { ...process.env, ...(req.env ?? {}) },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.pipe(outStream, { end: false });
    child.stderr?.pipe(errStream, { end: false });

    const pid = child.pid ?? 0;
    let killed = false;
    let timedOut = false;
    let settled = false;

    const cancel = async (): Promise<void> => {
      if (settled || !pid) return;
      killed = true;
      stopProcessTree(pid);
      await new Promise((r) => setTimeout(r, 150));
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (req.timeout_ms && req.timeout_ms > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        void cancel();
      }, req.timeout_ms);
      timer.unref?.();
    }

    const done = new Promise<{
      exit_code: number | null;
      signal: string | null;
      timed_out: boolean;
      killed: boolean;
      error?: string;
    }>((resolve) => {
      const finish = (res: {
        exit_code: number | null;
        signal: string | null;
        error?: string;
      }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const endStream = (s: ReturnType<typeof createWriteStream>) =>
          new Promise<void>((res) => {
            if (s.writableFinished || s.destroyed) return res();
            s.once("finish", res);
            s.once("close", res);
            s.end();
          });
        void Promise.all([endStream(outStream), endStream(errStream)]).then(() => {
          resolve({
            exit_code: res.exit_code,
            signal: res.signal,
            timed_out: timedOut,
            killed: killed && !timedOut,
            error: res.error,
          });
        });
      };

      child.once("error", (err) => {
        finish({ exit_code: null, signal: null, error: err.message });
      });
      child.once("close", (code, signal) => {
        finish({ exit_code: code, signal: signal ?? null });
      });
    });

    return { pid, cancel, done };
  },
};
