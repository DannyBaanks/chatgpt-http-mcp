// src/compute/executor.ts — Despachador multiplataforma de ejecutores y telemetría GPU.
// Carga dinámicamente `exec-win.ts`, `exec-wsl.ts` y `gpu-telemetry.ts` cuando están presentes
// (integrados desde la rama compañera de Windows Xeon) registrando errores reales de importación.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { posixComputeExecutor } from "./executor-posix";
import type { ComputeTarget, GpuTelemetrySnapshot, PlatformComputeExecutor } from "./types";

const registry = new Map<Exclude<ComputeTarget, "auto">, PlatformComputeExecutor>([
  ["posix", posixComputeExecutor],
]);

const loadErrors = new Map<string, string>();
let optionalLoaded = false;

export function registerComputeExecutor(exec: PlatformComputeExecutor): void {
  registry.set(exec.target, exec);
}

export function getExecutorLoadErrors(): Record<string, string> {
  return Object.fromEntries(loadErrors.entries());
}

async function ensureOptionalPlatformModules(): Promise<void> {
  if (optionalLoaded) return;
  optionalLoaded = true;
  const dir = import.meta.dir;

  const tryLoad = async (file: string, exportName: string) => {
    const full = join(dir, file);
    if (!existsSync(full)) return;
    try {
      const mod = (await import(full)) as Record<string, unknown>;
      const exec = mod[exportName] as PlatformComputeExecutor | undefined;
      if (exec && typeof exec.spawn === "function") {
        registry.set(exec.target, exec);
      } else {
        const msg = `${file} cargado pero no exporta ${exportName}.spawn`;
        loadErrors.set(file, msg);
        console.warn(`[isymcp:compute] ${msg}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadErrors.set(file, msg);
      console.warn(`[isymcp:compute] error al cargar módulo opcional ${file}: ${msg}`);
    }
  };

  await Promise.all([
    tryLoad("exec-win.ts", "winComputeExecutor"),
    tryLoad("exec-wsl.ts", "wslComputeExecutor"),
  ]);
}

export async function resolveComputeTarget(requested: ComputeTarget = "auto"): Promise<Exclude<ComputeTarget, "auto">> {
  if (requested !== "auto") return requested;
  return process.platform === "win32" ? "win" : "posix";
}

export async function getComputeExecutor(
  target: Exclude<ComputeTarget, "auto">,
): Promise<PlatformComputeExecutor | null> {
  await ensureOptionalPlatformModules();
  return registry.get(target) ?? null;
}

export async function readHostGpuTelemetry(): Promise<GpuTelemetrySnapshot> {
  const full = join(import.meta.dir, "gpu-telemetry.ts");
  if (existsSync(full)) {
    try {
      const mod = (await import(full)) as {
        readGpuTelemetry?: () => Promise<GpuTelemetrySnapshot>;
      };
      if (typeof mod.readGpuTelemetry === "function") {
        return await mod.readGpuTelemetry();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadErrors.set("gpu-telemetry.ts", msg);
      console.warn(`[isymcp:compute] error en gpu-telemetry.ts: ${msg}`);
      return {
        available: false,
        provider: "none",
        collected_at: new Date().toISOString(),
        gpus: [],
        error: msg,
      };
    }
  }
  return {
    available: false,
    provider: "none",
    collected_at: new Date().toISOString(),
    gpus: [],
  };
}
