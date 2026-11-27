// src/compute/types.ts — Interfaces congeladas del motor de cómputo remoto async (`01_CONTRACT_SPEC.md` v1).

export type ComputeTarget = "auto" | "posix" | "win" | "wsl";
export type ComputePriority = "idle" | "below_normal" | "normal";
export type ComputeJobStatus = "queued" | "running" | "done" | "failed" | "killed" | "timed_out";

export interface GpuDeviceTelemetry {
  index: number;
  name: string;
  vram_total_mb: number;
  vram_used_mb: number;
  vram_free_mb: number;
  utilization_pct: number | null;
  temperature_c: number | null;
}

export interface GpuTelemetrySnapshot {
  available: boolean;
  provider: "nvidia-smi" | "none";
  collected_at: string;
  gpus: GpuDeviceTelemetry[];
  error?: string;
}

export interface ComputeExecRequest {
  job_id: string;
  /** Ruta absoluta del directorio aislado del job (creado por queue.ts). */
  job_dir: string;
  /** Directorio de trabajo real dentro del job o ruta permitida. */
  cwd: string;
  /** O bien argv explícito, o comando de shell (al menos uno obligatorio). */
  argv?: string[];
  command?: string;
  target: Exclude<ComputeTarget, "auto">;
  /** Para target === "wsl": nombre de distro opcional (undefined = distro por defecto). */
  wsl_distro?: string;
  priority: ComputePriority;
  env?: Record<string, string>;
  timeout_ms?: number;
  /** Tope en bytes para stdout.log y stderr.log (cada uno). Default 32 MiB. */
  max_log_bytes?: number;
  /** Rutas donde el ejecutor debe volcar stdout y stderr en tiempo real. */
  stdout_path: string;
  stderr_path: string;
}

export interface ComputeRunningHandle {
  pid: number;
  /** Cancela el árbol completo de procesos (idempotente). */
  cancel: () => Promise<void>;
  /** Resuelve cuando el proceso termina por completo y los descriptores de log se cerraron. */
  done: Promise<{
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
    killed: boolean;
    error?: string;
  }>;
}

export interface PlatformComputeExecutor {
  readonly target: Exclude<ComputeTarget, "auto">;
  isAvailable(): Promise<boolean>;
  spawn(req: ComputeExecRequest): Promise<ComputeRunningHandle>;
}

export interface ComputeInputFile {
  /** Ruta relativa dentro de `work/` (sin `..` ni rutas absolutas). */
  path: string;
  content_b64: string;
}

export interface ComputeJobSubmitInput {
  argv?: string[];
  command?: string;
  target?: ComputeTarget;
  wsl_distro?: string;
  cwd?: string;
  gpu?: boolean;
  priority?: ComputePriority;
  env?: Record<string, string>;
  timeout_ms?: number;
  files?: ComputeInputFile[];
  label?: string;
}

export interface ComputeJobRecord {
  job_id: string;
  owner_office_id: string;
  owner_name: string;
  label: string;
  target: Exclude<ComputeTarget, "auto">;
  wsl_distro?: string;
  gpu: boolean;
  priority: ComputePriority;
  argv?: string[];
  command?: string;
  cwd: string;
  status: ComputeJobStatus;
  pid: number | null;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  timeout_ms?: number;
}
