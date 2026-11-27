/** Ejecutor de cómputo nativo Windows (owner: Windows Xeon, contrato Hive+Link+Compute v1 §2.2). */
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { stopProcessTree } from "../platform/process";
import { attachWindowsJobObject, type WindowsJobHandle } from "../platform/win-job";
import { buildSafeJobEnv } from "./env";
import type {
  ComputeExecRequest,
  ComputeRunningHandle,
  ComputePriority,
  PlatformComputeExecutor,
} from "./types";

/** Mapea la prioridad canónica del contrato a la clase de prioridad de Windows. */
export function mapWinPriorityClass(priority: ComputePriority): "Idle" | "BelowNormal" | "Normal" {
  switch (priority) {
    case "idle":
      return "Idle";
    case "below_normal":
      return "BelowNormal";
    default:
      return "Normal";
  }
}

/** Valores nice-equivalentes que `os.setPriority` traduce a las clases de Windows (Idle=19, BelowNormal=10, Normal=0). */
function niceValueFor(priority: ComputePriority): number {
  switch (priority) {
    case "idle":
      return os.constants.priority.PRIORITY_LOW;
    case "below_normal":
      return os.constants.priority.PRIORITY_BELOW_NORMAL;
    default:
      return os.constants.priority.PRIORITY_NORMAL;
  }
}

/**
 * Entorno sanitizado: solo variables inofensivas del host + las que pide el job.
 * Evita filtrar secretos del escritorio (tokens, cookies, claves de API) a procesos remotos.
 */
/** Exportado para reutilización por exec-wsl. Delega en la allowlist compartida (`env.ts`, case-insensitive en Windows). */
export function sanitizedEnv(extra?: Record<string, string>): Record<string, string> {
  return buildSafeJobEnv(extra);
}

/** Mismo default que executor-posix y queue: 32 MiB por stream. */
export const DEFAULT_MAX_LOG_BYTES = 32 * 1024 * 1024;

export function resolveMaxLogBytes(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_LOG_BYTES;
}

/**
 * Vuelca un ReadableStream al log del job con tope de bytes. Al llegar al tope escribe
 * el mismo aviso que executor-posix y SIGUE drenando (descartando) para que el hijo
 * nunca se bloquee con el pipe lleno. Exportado para exec-wsl.
 */
export async function pumpToLog(
  stream: ReadableStream<Uint8Array>,
  logPath: string,
  maxBytes: number = DEFAULT_MAX_LOG_BYTES,
): Promise<void> {
  // Apertura inmediata (igual que executor-posix): el log existe aunque el stream quede vacío.
  let sink: WriteStream | null = null;
  try {
    try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* la cola ya lo crea */ }
    const s = createWriteStream(logPath, { flags: "a" });
    await new Promise<void>((resolve, reject) => {
      s.once("open", () => resolve());
      s.once("error", reject);
    });
    sink = s;
  } catch { sink = null; /* sin log: aun así drenamos para no bloquear al hijo */ }

  let written = 0;
  let truncated = false;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (sink === null || truncated) continue;
      let chunk = value;
      if (written + chunk.length > maxBytes) {
        chunk = chunk.subarray(0, Math.max(0, maxBytes - written));
        truncated = true;
      }
      written += chunk.length;
      if (chunk.length > 0 && !sink.write(chunk)) {
        await new Promise<void>((resolve) => sink!.once("drain", resolve));
      }
      if (truncated) sink.write(`\n[isymcp] output truncated at ${maxBytes} bytes\n`);
    }
  } catch { /* el proceso murió a mitad de lectura: los logs quedan con lo recibido */ }
  finally {
    reader.releaseLock();
    if (sink !== null) await new Promise<void>((resolve) => sink!.end(resolve));
  }
}

function shellCommandToArgv(command: string): string[] {
  const comspec = process.env.ComSpec || `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
  // /d: sin AutoRun; /s: stripping de comillas exteriores predecible; /c: ejecutar y salir.
  return [comspec, "/d", "/s", "/c", command];
}

export const winComputeExecutor: PlatformComputeExecutor = {
  target: "win",

  async isAvailable(): Promise<boolean> {
    return process.platform === "win32";
  },

  async spawn(req: ComputeExecRequest): Promise<ComputeRunningHandle> {
    if (!req.argv && !req.command) {
      throw new Error("compute: el job debe traer `argv` o `command`");
    }
    const argv = req.argv && req.argv.length > 0 ? req.argv : shellCommandToArgv(req.command!);

    let timedOut = false;
    let killed = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let winJob: WindowsJobHandle | null = null;

    const handle: ComputeRunningHandle = {
      pid: 0,
      cancel: async () => {
        if (settled) return;
        killed = true;
        if (winJob) {
          try { winJob.terminate(); } catch { /* ya detenido */ }
        }
        if (handle.pid > 0) {
          // Mata el árbol completo (hijos + nietos) con taskkill /T /F como respaldo.
          try { stopProcessTree(handle.pid); } catch { /* ya detenido */ }
        }
      },
      done: undefined as unknown as Promise<{
        exit_code: number | null;
        signal: string | null;
        timed_out: boolean;
        killed: boolean;
        error?: string;
      }>,
    };

    handle.done = (async () => {
      let spawnError: string | undefined;
      let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
      try {
        proc = Bun.spawn(argv, {
          cwd: req.cwd,
          env: sanitizedEnv(req.env),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        handle.pid = proc.pid;
        winJob = attachWindowsJobObject(proc.pid);
      } catch (error) {
        spawnError = error instanceof Error ? error.message : String(error);
      }

      if (proc === null) {
        settled = true;
        return { exit_code: null, signal: null, timed_out: false, killed: false, error: spawnError };
      }

      // Prioridad best-effort: si Windows rechaza el cambio (privilegios), el job sigue en Normal.
      try { os.setPriority(handle.pid, niceValueFor(req.priority)); } catch { /* best-effort */ }

      if (req.timeout_ms && req.timeout_ms > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          void handle.cancel();
        }, req.timeout_ms);
      }

      const [exitCode] = await Promise.all([
        proc.exited,
        pumpToLog(proc.stdout as unknown as ReadableStream<Uint8Array>, req.stdout_path, resolveMaxLogBytes(req.max_log_bytes)),
        pumpToLog(proc.stderr as unknown as ReadableStream<Uint8Array>, req.stderr_path, resolveMaxLogBytes(req.max_log_bytes)),
      ]);

      if (timer !== null) clearTimeout(timer);
      settled = true;
      if (winJob) {
        try { winJob.close(); } catch { /* ignore */ }
        winJob = null;
      }
      return { exit_code: exitCode, signal: null, timed_out: timedOut, killed };
    })();

    return handle;
  },
};
