// src/compute/env.ts — Construcción de entorno mínimo seguro para procesos de cómputo remoto.
// Evita heredar secretos del proceso servidor (`isymcp link serve`) como GH_TOKEN, API keys o cookies.
// Este helper debe ser usado por `executor-posix.ts`, `exec-win.ts` y `exec-wsl.ts`.

const HOST_ENV_ALLOWLIST = new Set<string>([
  // POSIX / comunes
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  // CUDA / GPU
  "CUDA_VISIBLE_DEVICES",
  "NVIDIA_VISIBLE_DEVICES",
  "CUDA_HOME",
  "CUDA_PATH",
  // Windows esenciales
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "SystemDrive",
]);

const HOST_ENV_ALLOWLIST_LOWER = new Set<string>(
  [...HOST_ENV_ALLOWLIST].map((k) => k.toLowerCase()),
);

/**
 * Construye un entorno aislado para un job remoto copiando únicamente variables
 * operativas no sensibles del host (allowlist estricta) y superponiendo `userEnv`.
 */
export function buildSafeJobEnv(
  userEnv?: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  const isWin = process.platform === "win32";

  for (const [k, v] of Object.entries(hostEnv)) {
    if (typeof v !== "string") continue;
    const allowed = isWin ? HOST_ENV_ALLOWLIST_LOWER.has(k.toLowerCase()) : HOST_ENV_ALLOWLIST.has(k);
    if (allowed) out[k] = v;
  }

  if (!out.PATH && !out.Path) {
    out.PATH = isWin ? "C:\\Windows\\System32;C:\\Windows" : "/usr/local/bin:/usr/bin:/bin";
  }

  if (userEnv && typeof userEnv === "object") {
    for (const [k, v] of Object.entries(userEnv)) {
      if (typeof k !== "string" || !k || k.includes("=") || k.includes("\0")) continue;
      if (typeof v !== "string" || v.includes("\0")) continue;
      out[k] = v;
    }
  }

  return out;
}
