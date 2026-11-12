// src/shell/executor.ts — Ejecutor de comandos de shell arbitrarios con persistencia de CWD.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { stopProcessTree } from "../platform/process";
import { checkGate, runWithOperatorAuthorization, scrubbedEnv } from "../permissions";

//
// Autorización de shell en el host (fail-closed), ver src/permissions.ts:
//   1. ISYMCP_ALLOW_HOST_SHELL=1 en el entorno del proceso (operador).
//   2. `isymcp allow shell on` (~/.codex-web-http/permissions.json, se lee en cada llamada).
//   3. Un OperatorGrant firmado y de un solo uso del Control Center, consumido
//      ANTES de llegar aquí (runWithHostShellAuthorization).
// Sin ninguna, DENIED. codex_exec no pasa por aquí: usa sandboxPlan.
// El comando corre con un entorno limpio: sin tokens del bridge ni API keys.
//

/** Marca el contexto async actual como autorizado (OperatorGrant consumido). */
export function runWithHostShellAuthorization<T>(fn: () => T): T {
  return runWithOperatorAuthorization(fn);
}


export interface ShellExecOptions {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ShellExecResult {
  ok: boolean;
  command: string;
  cwd: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB

let activeCwd = process.cwd();

export function getActiveCwd(): string {
  return activeCwd;
}

export function setActiveCwd(newPath: string): boolean {
  const expanded = expandPath(newPath);
  const resolved = isAbsolute(expanded) ? expanded : resolve(activeCwd, expanded);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    activeCwd = resolved;
    return true;
  }
  return false;
}

function expandPath(p: string): string {
  let cleaned = p.trim().replace(/^["']|["']$/g, "").replace(/\\ /g, " ");
  if (cleaned === "~" || cleaned.startsWith("~/") || cleaned.startsWith("~\\")) {
    cleaned = homedir() + cleaned.slice(1);
  }
  return cleaned;
}

export async function executeShellCommand(options: ShellExecOptions): Promise<ShellExecResult> {
  const started = Date.now();
  const rawCommand = (options.command ?? "").trim();

  // Gate fail-closed: shell_exec corre sobre el HOST (sin bwrap), asi que solo
  // existe con opt-in explicito del operador. El resto de la superficie MCP
  // (codex_exec) si pasa por sandboxPlan; este gate no lo toca.
  const gate = checkGate("host_shell", "shell_exec", { command: rawCommand, cwd: options.cwd });
  if (!gate.ok) {
    return {
      ok: false,
      command: rawCommand,
      cwd: activeCwd,
      exit_code: 1,
      stdout: "",
      stderr: "",
      duration_ms: Date.now() - started,
      timed_out: false,
      error: gate.message,
    };
  }
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), 300_000);
  const maxBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  // 1. Si se solicita un cwd explícito, validarlo para esta ejecución sin contaminar activeCwd global
  let effectiveCwd = activeCwd;
  if (options.cwd) {
    const expanded = expandPath(options.cwd);
    const resolved = isAbsolute(expanded) ? expanded : resolve(activeCwd, expanded);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      return {
        ok: false,
        command: rawCommand,
        cwd: activeCwd,
        exit_code: 1,
        stdout: "",
        stderr: `Directorio de trabajo no válido o inaccesible: ${options.cwd}`,
        duration_ms: Date.now() - started,
        timed_out: false,
        error: `Directorio de trabajo no válido: ${options.cwd}`,
      };
    }
    effectiveCwd = resolved;
  }

  if (!rawCommand) {
    return {
      ok: false,
      command: "",
      cwd: activeCwd,
      exit_code: 1,
      stdout: "",
      stderr: "Comando vacío.",
      duration_ms: 0,
      timed_out: false,
      error: "Comando vacío",
    };
  }

  // 2. Interceptar comando 'pwd' solitario
  if (rawCommand === "pwd") {
    return {
      ok: true,
      command: rawCommand,
      cwd: activeCwd,
      exit_code: 0,
      stdout: `${activeCwd}\n`,
      stderr: "",
      duration_ms: Date.now() - started,
      timed_out: false,
    };
  }

  // 3. Interceptar comando 'cd' solitario (sin pipelines ni encadenamientos)
  const cdMatch = rawCommand.match(/^cd(?:\s+(.*))?$/);
  const isChained = /[;&|]|\n/.test(rawCommand);

  if (cdMatch && !isChained) {
    // En Windows, 'cd' sin argumentos imprime el directorio actual
    if (!cdMatch[1]?.trim() && process.platform === "win32") {
      return {
        ok: true,
        command: rawCommand,
        cwd: activeCwd,
        exit_code: 0,
        stdout: `${activeCwd}\n`,
        stderr: "",
        duration_ms: Date.now() - started,
        timed_out: false,
      };
    }

    const target = cdMatch[1]?.trim() || "~";
    const ok = setActiveCwd(target);
    const duration = Date.now() - started;
    if (ok) {
      return {
        ok: true,
        command: rawCommand,
        cwd: activeCwd,
        exit_code: 0,
        stdout: `Directorio cambiado a: ${activeCwd}`,
        stderr: "",
        duration_ms: duration,
        timed_out: false,
      };
    } else {
      return {
        ok: false,
        command: rawCommand,
        cwd: activeCwd,
        exit_code: 1,
        stdout: "",
        stderr: `bash: cd: ${target}: No existe el archivo o el directorio`,
        duration_ms: duration,
        timed_out: false,
        error: `bash: cd: ${target}: No existe el directorio`,
      };
    }
  }

  // 3. Ejecutar comando general en bash/cmd según plataforma
  return new Promise((resolveResult) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    let procExited = false;

    const isWindows = process.platform === "win32";
    const shellBinary = isWindows ? (process.env.COMSPEC || "cmd.exe") : "bash";
    const shellArgs = isWindows ? ["/d", "/s", "/c", rawCommand] : ["-c", rawCommand];

    const proc = spawn(shellBinary, shellArgs, {
      cwd: effectiveCwd,
      env: scrubbedEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid) {
        try {
          stopProcessTree(proc.pid);
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }
      stderrBuf += `\n[TIMEOUT] El comando excedió el tiempo límite asignado (${timeoutMs} ms) y fue terminado.`;

      // Prevenir cuelgue si el proceso no cierra pipes tras SIGKILL
      setTimeout(() => {
        if (!procExited) {
          procExited = true;
          resolveResult({
            ok: false,
            command: rawCommand,
            cwd: effectiveCwd,
            exit_code: 124,
            stdout: stdoutBuf,
            stderr: stderrBuf,
            duration_ms: Date.now() - started,
            timed_out: true,
            error: `Timeout de ${timeoutMs}ms excedido`,
          });
        }
      }, 1500).unref();
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBuf.length < maxBytes) {
        stdoutBuf += chunk.toString("utf8");
        if (stdoutBuf.length >= maxBytes) {
          stdoutBuf += "\n[TRUNCATED: Salida recortada por límite de tamaño (512 KB)]";
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < maxBytes) {
        stderrBuf += chunk.toString("utf8");
        if (stderrBuf.length >= maxBytes) {
          stderrBuf += "\n[TRUNCATED: Salida recortada por límite de tamaño (512 KB)]";
        }
      }
    });

    proc.on("error", (err: Error) => {
      if (procExited) return;
      procExited = true;
      clearTimeout(timer);
      resolveResult({
        ok: false,
        command: rawCommand,
        cwd: effectiveCwd,
        exit_code: 1,
        stdout: stdoutBuf,
        stderr: `${stderrBuf}\nError al iniciar proceso: ${err.message}`.trim(),
        duration_ms: Date.now() - started,
        timed_out: timedOut,
        error: err.message,
      });
    });

    proc.on("close", (code: number | null) => {
      if (procExited) return;
      procExited = true;
      clearTimeout(timer);
      const exitCode = code ?? (timedOut ? 124 : 1);
      resolveResult({
        ok: exitCode === 0 && !timedOut,
        command: rawCommand,
        cwd: effectiveCwd,
        exit_code: exitCode,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        duration_ms: Date.now() - started,
        timed_out: timedOut,
      });
    });
  });
}
