/** Ejecutor de cómputo hacia WSL2 desde Windows (owner: Windows Xeon, contrato Hive+Link+Compute v1 §2.3). */
import { stopProcessTree } from "../platform/process";
import { pumpToLog, resolveMaxLogBytes, sanitizedEnv } from "./exec-win";
import type {
  ComputeExecRequest,
  ComputeRunningHandle,
  PlatformComputeExecutor,
} from "./types";

const WSL_EXE = "wsl.exe";

/**
 * Traduce una ruta Windows a su equivalente en WSL2 (`/mnt/<letra>/...`).
 * Pura y testeable en cualquier OS. Las rutas que ya son POSIX se devuelven intactas.
 */
export function windowsPathToWsl(winPath: string): string {
  const normalized = winPath.replaceAll("\\", "/").trim();
  const driveMatch = normalized.match(/^([A-Za-z]):(\/|$)/);
  if (!driveMatch) return normalized; // ya es ruta POSIX (o relativa): no se toca
  const drive = driveMatch[1].toLowerCase();
  const rest = normalized.slice(driveMatch[0].length).replace(/\/+$/, "");
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

/** Escapado POSIX con comillas simples (el estándar: ' → '\''). */
function shquote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Genera el script POSIX del job. Se copia a un ARCHIVO dentro de WSL y se
 * ejecuta como `sh <archivo>`: la línea de comando de la sesión NUNCA contiene
 * el texto del script, así que ninguna capa de quoting de wsl.exe puede
 * degradarlo (observado: wsl.exe reinyecta el stdin por `sh -c "..."` en
 * docker-desktop, expandiendo $$ y rompiendo el script).
 * La primera línea registra $$ (PGID de la sesión setsid) para la cancelación;
 * `exec` conserva el PID, así que `kill -- -PGID` mata el árbol completo.
 */
function buildJobScript(req: ComputeExecRequest, pidFileWsl: string): string {
  const lines: string[] = [`echo $$ > ${shquote(pidFileWsl)}`];
  const wslCwd = /^[A-Za-z]:[\\/]/.test(req.cwd) ? windowsPathToWsl(req.cwd) : req.cwd;
  // cd DENTRO del script (no --cd): distros sin drvfs (docker-desktop) fallan
  // antes de ejecutar nada con --cd; aquí el fallo es controlado y claro.
  lines.push(
    `cd ${shquote(wslCwd)} 2>/dev/null || { printf 'compute: cwd WSL inaccesible: %s\\n' ${shquote(wslCwd)} >&2; exit 66; }`,
  );
  for (const [key, value] of Object.entries(req.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // nombre invalido: se ignora, no se explota
    lines.push(`export ${key}=${shquote(value)}`);
  }
  const nice = req.priority === "idle" ? "nice -n 15 " : req.priority === "below_normal" ? "nice -n 10 " : "";
  if (req.argv && req.argv.length > 0) {
    lines.push(`exec ${nice}${req.argv.map(shquote).join(" ")}`);
  } else if (req.command) {
    // bash -lc es el camino canónico; distros mínimas sin bash (docker-desktop,
    // alpine) caen a sh -c en vez de morir con 127.
    const cmd = shquote(req.command);
    lines.push(
      `if command -v bash >/dev/null 2>&1; then exec ${nice}bash -lc ${cmd}; else exec ${nice}sh -c ${cmd}; fi`,
    );
  } else {
    throw new Error("compute: el job debe traer `argv` o `command`");
  }
  return lines.join("\n") + "\n";
}

/** Rutas de coordinación DENTRO del filesystem de WSL (agnóstico de drvfs). Solo [A-Za-z0-9._-]. */
function wslCoordPaths(jobId: string): { pidFile: string; scriptFile: string } {
  const safe = jobId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return {
    pidFile: `/tmp/isymcp-compute-${safe}.pid`,
    scriptFile: `/tmp/isymcp-compute-${safe}.sh`,
  };
}

function wslBaseArgs(wslDistro?: string): string[] {
  const args: string[] = [WSL_EXE];
  if (wslDistro) args.push("-d", wslDistro);
  // --exec: sin shell default de la distro. TODOS los argumentos que siguen
  // están libres de espacios (rutas de coordinación con charset restringido).
  return args;
}

function wslRunSync(wslDistro: string | undefined, args: string[], timeoutMs = 5000): number | null {
  try {
    return Bun.spawnSync(wslBaseArgs(wslDistro).concat("--exec", args), {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: timeoutMs,
    }).exitCode;
  } catch {
    return null;
  }
}

function wslReadFile(wslDistro: string | undefined, path: string): string | null {
  try {
    const proc = Bun.spawnSync(wslBaseArgs(wslDistro).concat("--exec", "cat", path), {
      stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000,
    });
    return proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout).trim() : null;
  } catch {
    return null;
  }
}

async function killLinuxProcessGroup(wslDistro: string | undefined, pidFile: string): Promise<void> {
  const raw = wslReadFile(wslDistro, pidFile);
  const pgid = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (Number.isInteger(pgid) && pgid > 0) {
    for (const signal of ["-TERM", "-KILL"]) {
      // El PID registrado es el líder de sesión (setsid): -PGID mata el árbol completo.
      wslRunSync(wslDistro, ["kill", signal, "--", String(-pgid)]);
      // Pausa breve entre TERM y KILL para no dejar procesos medio muertos.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

export const wslComputeExecutor: PlatformComputeExecutor = {
  target: "wsl",

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    try {
      const proc = Bun.spawnSync([WSL_EXE, "--status"], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 5000,
      });
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  },

  async spawn(req: ComputeExecRequest): Promise<ComputeRunningHandle> {
    if (!req.argv && !req.command) {
      throw new Error("compute: el job debe traer `argv` o `command`");
    }
    const { pidFile, scriptFile } = wslCoordPaths(req.job_id);
    const script = buildJobScript(req, pidFile);

    let timedOut = false;
    let killed = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handle: ComputeRunningHandle = {
      pid: 0,
      cancel: async () => {
        if (settled) return;
        killed = true;
        // 1) Mata el grupo de procesos DENTRO de WSL (PID/PGID registrado por setsid).
        try { await killLinuxProcessGroup(req.wsl_distro, pidFile); } catch { /* seguimos */ }
        // 2) Mata el wrapper wsl.exe en Windows para no dejar huérfanos.
        try { stopProcessTree(handle.pid); } catch { /* ya detenido */ }
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
        // Paso 1: copiar el script a un archivo DENTRO de WSL (stdin → cp /dev/stdin).
        const copy = Bun.spawn(wslBaseArgs(req.wsl_distro).concat("--exec", "sh", "-c", "umask 077 && cat > \"$0\"", scriptFile), {
          env: sanitizedEnv(),
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        });
        copy.stdin.write(script);
        copy.stdin.end();
        const copyExit = await copy.exited;
        if (copyExit !== 0) throw new Error(`compute: no se pudo copiar el script del job a WSL (exit ${copyExit})`);

        // Paso 2: ejecutar el archivo bajo setsid. `-w` es obligatorio: wsl.exe
        // lanza el proceso como líder de grupo, setsid FORKEA y sin -w el padre
        // sale al instante (exit 0, salida vacía).
        proc = Bun.spawn(wslBaseArgs(req.wsl_distro).concat("--exec", "setsid", "-w", "sh", scriptFile), {
          env: sanitizedEnv(),
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
      // Limpieza best-effort de los archivos de coordinación dentro de WSL.
      wslRunSync(req.wsl_distro, ["rm", "-f", pidFile, scriptFile]);
      return { exit_code: exitCode, signal: null, timed_out: timedOut, killed };
    })();

    return handle;
  },
};
