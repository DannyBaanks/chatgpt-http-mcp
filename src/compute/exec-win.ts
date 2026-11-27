/** Ejecutor de cómputo nativo Windows (owner: Windows Xeon, contrato Hive+Link+Compute v1 §2.2). */
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { stopProcessTree } from "../platform/process";
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
const SAFE_ENV_KEYS = [
  "SystemRoot", "windir", "ComSpec", "PATHEXT", "PATH",
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "COMPUTERNAME", "USERNAME", "USERDOMAIN", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
] as const;

/** Exportado para reutilización por exec-wsl (ambos archivos son propiedad Windows). */
export function sanitizedEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

/** Vuelca un ReadableStream en streaming (append/create) al archivo de log del job. Exportado para exec-wsl. */
export async function pumpToLog(stream: ReadableStream<Uint8Array>, logPath: string): Promise<void> {
  // Apertura inmediata (igual que executor-posix): el log existe aunque el stream quede vacío.
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* la cola ya lo crea */ }
  const sink: WriteStream = createWriteStream(logPath, { flags: "a" });
  await new Promise<void>((resolve, reject) => {
    sink.once("open", () => resolve());
    sink.once("error", reject);
  });
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!sink.write(value)) {
        await new Promise<void>((resolve) => sink!.once("drain", resolve));
      }
    }
  } catch { /* el proceso murió a mitad de lectura: los logs quedan con lo recibido */ }
  finally {
    reader.releaseLock();
    await new Promise<void>((resolve) => sink.end(resolve));
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

    const handle: ComputeRunningHandle = {
      pid: 0,
      cancel: async () => {
        if (settled) return;
        killed = true;
        if (handle.pid > 0) {
          // Mata el árbol completo (hijos + nietos) con taskkill /T /F.
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
        pumpToLog(proc.stdout as unknown as ReadableStream<Uint8Array>, req.stdout_path),
        pumpToLog(proc.stderr as unknown as ReadableStream<Uint8Array>, req.stderr_path),
      ]);

      if (timer !== null) clearTimeout(timer);
      settled = true;
      return { exit_code: exitCode, signal: null, timed_out: timedOut, killed };
    })();

    return handle;
  },
};
