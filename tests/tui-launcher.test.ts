// tests/tui-launcher.test.ts — Pruebas unitarias para el spawner de TUI de Antigravity (agy).
import { describe, expect, it } from "bun:test";
import { detectTerminalEmulator, findAgyBinary, spawnAgyTui } from "../src/tui-launcher";

describe("TUI Launcher Suite", () => {
  it("TL-01: detectTerminalEmulator detects installed terminal emulators on Linux", () => {
    const term = detectTerminalEmulator();
    expect(term).not.toBeNull();
    expect(typeof term).toBe("string");
    expect(term).toContain("/usr/bin/");
  });

  it("TL-02: findAgyBinary resolves the agy command path or binary name", () => {
    const agy = findAgyBinary();
    expect(agy).toBeDefined();
    expect(typeof agy).toBe("string");
  });

  it("TL-03: spawnAgyTui builds options and executes cleanly with detached child", async () => {
    // Dry-run para no abrir ventanas reales durante el test suite
    const res = await spawnAgyTui({
      prompt: "Prueba unitaria ISyMCP TUI",
      title: "Test Unitario TUI",
      includeMonitorHint: true,
      terminalPreference: "auto",
      dryRun: true,
    });

    expect(res).toBeDefined();
    expect(res.ok).toBe(true);
    expect(res.terminal).toBeDefined();
    expect(res.command.length).toBeGreaterThan(0);
    expect(res.message).toContain("exitosamente");
  });
});
