/** Process helpers that keep platform-specific process inspection in one place. */
// Bits 0..6 of the exit code are results; bit 7 (128) is the "I finished" sentinel.
const MAX_NEEDLES = 7;

function powershellPath(): string {
  return process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
}

/**
 * Several searches in ONE process enumeration. PowerShell returns only a status
 * code so command lines (which may contain unrelated user arguments) never reach
 * the panel or CLI output. The code is 128 | mask of matches: anything below 128
 * means PowerShell failed, timed out or had no CIM access, and all of those are
 * read as no match at all — never as "pattern 0 matched", which is exactly what a
 * bare `exit 1` from a broken script would otherwise say. An empty needle matches
 * every command line (`IndexOf("")` is 0), so it is refused on both platforms.
 */
export function processMatchesTable(patterns: readonly string[]): boolean[] {
  const found = patterns.map(() => false);

  if (process.platform !== "win32") {
    patterns.forEach((pattern, index) => {
      if (!pattern) return;
      try {
        const result = Bun.spawnSync(["pgrep", "-f", pattern], { stdout: "ignore", stderr: "ignore", timeout: 2500 });
        found[index] = result.exitCode === 0;
      } catch { /* fail closed */ }
    });
    return found;
  }

  for (let start = 0; start < patterns.length; start += MAX_NEEDLES) {
    const chunk = patterns.slice(start, start + MAX_NEEDLES);
    const literal = chunk.map((pattern) => `'${pattern.replaceAll("'", "''")}'`).join(",");
    const script = `$n=@(${literal}); $bits=128; Get-CimInstance Win32_Process | ForEach-Object { $p=$_; if ($p.ProcessId -ne $PID -and $p.CommandLine) { for ($i=0; $i -lt $n.Count; $i++) { if ($n[$i] -and -not ($bits -band (1 -shl $i)) -and $p.CommandLine.IndexOf($n[$i],[System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $bits = $bits -bor (1 -shl $i) } } } }; exit $bits`;
    try {
      const code = Bun.spawnSync([powershellPath(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        stdout: "ignore", stderr: "ignore", timeout: 10_000,
      }).exitCode;
      if (code === null || code < 128) continue;
      chunk.forEach((_, offset) => { found[start + offset] = (code & (1 << offset)) !== 0; });
    } catch { /* fail closed */ }
  }
  return found;
}

export function processMatches(pattern: string): boolean {
  return processMatchesTable([pattern])[0] ?? false;
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
