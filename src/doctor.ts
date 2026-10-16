// doctor.ts — M3: diagnostico determinista del entorno local de ISyMCP.
//
// Solo lee: binarios, versiones, sandbox, disco, catalogo de media y el ultimo
// import fallido. No usa red ni modelo. `--explain` (M6) es una capa aparte.
import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { youtubeDownloaderBinary } from "./media/youtube";
import { sandboxAvailable, sandboxLabel, sandboxUnavailableReason } from "./codex-sessions";
import { defaultBrowserExecutable } from "./platform/browser";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  version: string;
  ok: boolean;
  checks: DoctorCheck[];
  errors: DoctorCheck[];
}

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  probe?: (command: string, args: string[]) => string | undefined;
  exists?: (path: string) => boolean;
  mediaHome?: string;
  home?: string;
}

function realProbe(command: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(command, args, { timeout: 8000, encoding: "utf8" });
    if (result.error || result.status !== 0) return undefined;
    return (result.stdout || result.stderr || "").trim().split("\n")[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function mediaStateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ISYMCP_MEDIA_HOME?.trim() || join(homedir(), ".local", "state", "isymcp", "media");
}

interface FailedImport {
  error_code?: string;
  error?: string;
  phase?: string;
}

/** Ultimo import fallido del catalogo local (job.json mas reciente). */
export function latestFailedImport(mediaHome: string): FailedImport | undefined {
  const downloads = join(mediaHome, "downloads");
  let entries: string[];
  try {
    entries = readdirSync(downloads);
  } catch {
    return undefined;
  }
  let best: { mtime: number; job: FailedImport } | undefined;
  for (const name of entries) {
    const jobPath = join(downloads, name, "job.json");
    try {
      const mtime = statSync(jobPath).mtimeMs;
      const job = JSON.parse(readFileSync(jobPath, "utf8")) as FailedImport & { state?: string };
      if (job.state !== "failed") continue;
      if (!best || mtime > best.mtime) best = { mtime, job };
    } catch {
      /* directorio sin job.json legible: se ignora */
    }
  }
  return best?.job;
}

export function runDoctor(deps: DoctorDeps = {}): DoctorReport {
  const env = deps.env ?? process.env;
  const probe = deps.probe ?? realProbe;
  const exists = deps.exists ?? existsSync;
  const mediaHome = deps.mediaHome ?? mediaStateHome(env);
  const home = deps.home ?? homedir();
  const checks: DoctorCheck[] = [];
  const add = (id: string, label: string, status: DoctorStatus, detail: string) => checks.push({ id, label, status, detail });

  add("node", "node", "ok", process.version);
  const bun = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  add("bun", "bun", bun ? "ok" : "warn", bun ?? "no es un proceso bun (bun solo hace falta para desarrollo)");
  add("platform", "plataforma", "ok", `${process.platform} ${process.arch}`);

  const ytdlp = youtubeDownloaderBinary(env);
  const ytdlpVersion = !isAbsolute(ytdlp) || exists(ytdlp) ? probe(ytdlp, ["--version"]) : undefined;
  if (ytdlpVersion) add("yt-dlp", "yt-dlp", "ok", `${ytdlpVersion} (${ytdlp})`);
  else add("yt-dlp", "yt-dlp", "fail", `no encontrado o sin --version: ${ytdlp}`);

  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    const version = probe(tool, ["-version"]);
    if (version) add(tool, tool, "ok", version.slice(0, 80));
    else add(tool, tool, "fail", `no encontrado en PATH (media lo necesita)`);
  }

  const browser = defaultBrowserExecutable();
  add("browser", "navegador", exists(browser) ? "ok" : "warn", exists(browser) ? browser : `${browser} (solo para captura visible)`);

  if (sandboxAvailable()) add("sandbox", "sandbox", "ok", sandboxLabel({ writable: false }));
  else add("sandbox", "sandbox", "warn", sandboxUnavailableReason());

  try {
    const fs = statfsSync(exists(mediaHome) ? mediaHome : home);
    const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
    const status: DoctorStatus = freeGb < 1 ? "fail" : freeGb < 5 ? "warn" : "ok";
    add("disk", "disco libre", status, `${freeGb.toFixed(1)} GB`);
  } catch {
    add("disk", "disco libre", "warn", `no se pudo medir ${mediaHome}`);
  }

  add("catalog", "catalogo de media", exists(mediaHome) ? "ok" : "warn", exists(mediaHome) ? mediaHome : `aun no existe: ${mediaHome}`);

  const failed = latestFailedImport(mediaHome);
  if (failed) add("media-error", "ultimo fallo de media", "warn", `${failed.error_code ?? "media_unknown"}: ${failed.error ?? failed.phase ?? ""}`.trim());
  else add("media-error", "ultimo fallo de media", "ok", "sin fallos registrados");

  const errors = checks.filter((check) => check.status === "fail");
  return { version: "isymcp-doctor/1", ok: errors.length === 0, checks, errors };
}

export function formatDoctor(report: DoctorReport): string {
  const mark: Record<DoctorStatus, string> = { ok: "ok  ", warn: "aviso", fail: "FALLA" };
  const lines = ["isymcp doctor", ""];
  for (const check of report.checks) lines.push(`  ${mark[check.status]}  ${check.label.padEnd(16)} ${check.detail}`.trimEnd());
  const ok = report.checks.filter((c) => c.status === "ok").length;
  const warn = report.checks.filter((c) => c.status === "warn").length;
  lines.push("", `${ok} ok, ${warn} aviso, ${report.errors.length} falla`);
  return lines.join("\n");
}
