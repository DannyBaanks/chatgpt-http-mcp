/** Telemetría GPU cacheada para la cola de cómputo (owner: Windows Xeon, contrato Hive+Link+Compute v1 §2.1). */
import type { GpuDeviceTelemetry, GpuTelemetrySnapshot } from "./types";

const DEFAULT_CACHE_TTL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 4000;
const QUERY_FIELDS =
  "--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu --format=csv,noheader,nounits";

interface CacheEntry {
  snapshot: GpuTelemetrySnapshot;
  collected_at_ms: number;
}

let cache: CacheEntry | null = null;

/** Divide una línea CSV de nvidia-smi respetando campos entrecomillados (algunos nombres de GPU llevan coma). */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } else inQuotes = false;
      } else current += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { fields.push(current); current = ""; }
    else current += ch;
  }
  fields.push(current);
  return fields;
}

function toNumberOrNull(raw: string): number | null {
  const value = raw.trim();
  if (!value || /^\[.*(n\/a|not supported|unknown).*\]$/i.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Convierte la salida `--format=csv,noheader,nounits` en telemetría por dispositivo. Exportado para tests. */
export function parseNvidiaSmiOutput(output: string): GpuDeviceTelemetry[] {
  const gpus: GpuDeviceTelemetry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = splitCsvLine(line);
    if (fields.length < 7) continue;
    const index = toNumberOrNull(fields[0]);
    if (index === null) continue;
    gpus.push({
      index,
      name: fields[1].trim(),
      vram_total_mb: toNumberOrNull(fields[2]) ?? 0,
      vram_used_mb: toNumberOrNull(fields[3]) ?? 0,
      vram_free_mb: toNumberOrNull(fields[4]) ?? 0,
      utilization_pct: toNumberOrNull(fields[5]),
      temperature_c: toNumberOrNull(fields[6]),
    });
  }
  return gpus;
}

function nvidiaSmiCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.SystemRoot) {
    candidates.push(`${process.env.SystemRoot}\\System32\\nvidia-smi.exe`);
  }
  candidates.push("nvidia-smi");
  return candidates;
}

/**
 * Consulta `nvidia-smi` con el comando indicado (o los candidatos por defecto).
 * NUNCA lanza: cualquier fallo se degrada a `{ available: false, provider: "none" }`.
 * Exportado para tests (permite inyectar un comando inexistente en hosts con GPU).
 */
export async function probeGpuTelemetry(
  command?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<GpuTelemetrySnapshot> {
  const collectedAt = new Date().toISOString();
  const candidates = command ? [command] : nvidiaSmiCandidates();
  let lastError = "nvidia-smi no encontrado";
  for (const candidate of candidates) {
    try {
      const proc = Bun.spawn([candidate, ...QUERY_FIELDS.split(" ")], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* ya murió */ } }, timeoutMs);
      let stdout = "";
      try {
        [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      } finally {
        clearTimeout(timer);
      }
      const gpus = parseNvidiaSmiOutput(stdout);
      if (gpus.length > 0) {
        return { available: true, provider: "nvidia-smi", collected_at: collectedAt, gpus };
      }
      lastError = `nvidia-smi respondió sin telemetría parseable (exit ${proc.exited})`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { available: false, provider: "none", collected_at: collectedAt, gpus: [], error: lastError };
}

/**
 * Lectura cacheada de la telemetría GPU (firma exacta exigida por el contrato §2.1).
 * Los fallos también se cachean con el mismo TTL para no martillear `nvidia-smi`.
 */
export async function readGpuTelemetry(opts?: {
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<GpuTelemetrySnapshot> {
  const ttlMs = opts?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = Date.now();
  if (!opts?.forceRefresh && cache && now - cache.collected_at_ms < ttlMs) {
    return cache.snapshot;
  }
  const snapshot = await probeGpuTelemetry(undefined, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  cache = { snapshot, collected_at_ms: Date.now() };
  return snapshot;
}
