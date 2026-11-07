// tests/shell-exec.test.ts — Pruebas para ejecutor de comandos shell arbitrarios y CWD.
import { describe, expect, it } from "bun:test";
import { executeShellCommand, getActiveCwd, setActiveCwd } from "../src/shell/executor";
import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";

describe("Shell Executor Suite", () => {
  it("SE-01: executes a standard shell command and returns output", async () => {
    const res = await executeShellCommand({ command: "echo 'ISYMCP_SHELL_TEST'" });
    expect(res.ok).toBe(true);
    expect(res.exit_code).toBe(0);
    expect(res.stdout).toContain("ISYMCP_SHELL_TEST");
    expect(res.stderr).toBe("");
    expect(res.timed_out).toBe(false);
  });

  it("SE-02: returns non-zero exit code and stderr on failure", async () => {
    const res = await executeShellCommand({ command: "nonexistent_command_xyz_123" });
    expect(res.ok).toBe(false);
    expect(res.exit_code).not.toBe(0);
    expect(res.stderr.length + res.stdout.length).toBeGreaterThan(0);
  });

  it("SE-03: supports changing working directory with 'cd' and persists it", async () => {
    const initialCwd = getActiveCwd();
    const targetDir = realpathSync(tmpdir());
    const resCd = await executeShellCommand({ command: `cd "${targetDir}"` });
    expect(resCd.ok).toBe(true);
    expect(getActiveCwd().toLowerCase()).toBe(targetDir.toLowerCase());

    const pwdCmd = process.platform === "win32" ? "cd" : "pwd";
    const resPwd = await executeShellCommand({ command: pwdCmd });
    expect(resPwd.ok).toBe(true);
    expect(resPwd.stdout.toLowerCase()).toContain(targetDir.toLowerCase());

    // Restaurar cwd
    setActiveCwd(initialCwd);
  });

  it("SE-04: rejects invalid cd target without altering current cwd", async () => {
    const initialCwd = getActiveCwd();
    const res = await executeShellCommand({ command: "cd /nonexistent_path_definitely_not_here_456" });
    expect(res.ok).toBe(false);
    expect(res.exit_code).toBe(1);
    expect(res.stderr).toContain("No existe");
    expect(getActiveCwd()).toBe(initialCwd);
  });

  it("SE-05: expands ~ to home directory", async () => {
    const initialCwd = getActiveCwd();
    const res = await executeShellCommand({ command: "cd ~" });
    expect(res.ok).toBe(true);
    expect(getActiveCwd().toLowerCase()).toBe(homedir().toLowerCase());

    // Restaurar
    setActiveCwd(initialCwd);
  });

  it("SE-06: respects timeoutMs and kills long running process", async () => {
    const sleepCmd = process.platform === "win32" ? "ping -n 6 127.0.0.1 > nul" : "sleep 5";
    const res = await executeShellCommand({ command: sleepCmd, timeoutMs: 1000 });
    expect(res.ok).toBe(false);
    expect(res.timed_out).toBe(true);
    expect(res.stderr).toContain("[TIMEOUT]");
  });

  it("SE-07: rejects empty command", async () => {
    const res = await executeShellCommand({ command: "   " });
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("vacío");
  });
});
