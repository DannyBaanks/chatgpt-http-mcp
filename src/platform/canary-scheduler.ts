import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { securePrivatePath } from "./private-path";

const WINDOWS_TASK_NAME = "ISyMCP Canary";

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsPowerShellPath(): string {
  return join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function run(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export function windowsCanaryScriptPath(home: string): string {
  return join(home, "bin", "isymcp-canary.ps1");
}

export function installWindowsCanaryTask(options: { home: string; bunPath: string; entryPath: string }): void {
  const scriptPath = windowsCanaryScriptPath(options.home);
  mkdirSync(dirname(scriptPath), { recursive: true });
  securePrivatePath(dirname(scriptPath), true);
  writeFileSync(scriptPath, [
    "$ErrorActionPreference = 'Stop'",
    `$env:CODEX_WEB_HTTP_HOME = ${powershellQuote(options.home)}`,
    `& ${powershellQuote(options.bunPath)} run ${powershellQuote(options.entryPath)} canary run`,
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n"), { flag: "w" });
  securePrivatePath(scriptPath, false);

  const action = `"${windowsPowerShellPath()}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`;
  const result = run([
    "schtasks.exe", "/Create", "/TN", WINDOWS_TASK_NAME, "/SC", "DAILY", "/ST", "09:00",
    "/TR", action, "/F", "/IT", "/RL", "LIMITED",
  ]);
  if (result.exitCode !== 0) throw Error(`schtasks /Create fallo: ${result.stderr.trim() || result.stdout.trim()}`);
}

export function removeWindowsCanaryTask(home: string): void {
  const result = run(["schtasks.exe", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
  if (result.exitCode !== 0 && queryWindowsCanaryTask()?.exists !== false) throw Error(`schtasks /Delete fallo: ${result.stderr.trim() ||
    result.stdout.trim()}`);
  const scriptPath = windowsCanaryScriptPath(home);
  if (existsSync(scriptPath)) rmSync(scriptPath);
}

export function windowsCanaryScheduled(): boolean | null {
  const state = queryWindowsCanaryTask();
  if (!state) return null;
  return state.exists ? state.enabled : false;
}

function queryWindowsCanaryTask(): { exists: boolean; enabled: boolean | null } | null {
  try {
    const result = run(["schtasks.exe", "/Query", "/TN", WINDOWS_TASK_NAME, "/XML"]);
    if (result.exitCode !== 0) return { exists: false, enabled: false };
    const enabled = /<Enabled>\s*(true|false)\s*<\/Enabled>/i.exec(result.stdout);
    return { exists: true, enabled: enabled ? enabled[1]!.toLowerCase() === "true" : null };
  } catch {
    return null;
  }
}
