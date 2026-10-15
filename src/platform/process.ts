/** Process helpers that keep platform-specific process inspection in one place. */
export function processMatches(pattern: string): boolean {
  if (process.platform !== "win32") {
    try {
      const result = Bun.spawnSync(["pgrep", "-f", pattern], { stdout: "ignore", stderr: "ignore", timeout: 2500 });
      return result.exitCode === 0;
    } catch { return false; }
  }

  // PowerShell returns only a status code so command lines (which may contain
  // unrelated user arguments) never reach the panel or CLI output.
  const needle = pattern.replaceAll("'", "''");
  const script = `$needle='${needle}'; $found=$false; Get-CimInstance Win32_Process | ForEach-Object { if (-not $found -and $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($needle,[System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $found=$true } }; if ($found) { exit 0 } else { exit 1 }`;
  const powershell = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
  try {
    const result = Bun.spawnSync([powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdout: "ignore", stderr: "ignore", timeout: 8000,
    });
    return result.exitCode === 0;
  } catch { return false; }
}

export function stopProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
    return;
  }
  try {
    Bun.spawnSync(["taskkill.exe", "/PID", String(pid), "/T", "/F"], {
      stdout: "ignore", stderr: "ignore", timeout: 10000,
    });
  } catch { /* already stopped */ }
}
