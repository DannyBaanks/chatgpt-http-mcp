// tests/tui-launcher.test.ts — Pruebas unitarias para el spawner de TUI de Antigravity (agy).
import { describe, expect, it } from "bun:test";
import { detectTerminalEmulator, findAgyBinary, spawnAgyTui } from "../src/tui-launcher";

describe("TUI Launcher Suite", () => {
  it("TL-01: detectTerminalEmulator detects installed terminal emulators on Linux", () => {
    const term = detectTerminalEmulator();
    // En entornos headless (CI sin X11/Wayland ni emuladores de escritorio instalados), puede ser null
    if (term !== null) {
      expect(typeof term).toBe("string");
      expect(term).toContain("/usr/bin/");
    } else {
      expect(term).toBeNull();
    }
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

  it("TL-04: dangerouslySkipPermissions defaults to false and is excluded from agy args", async () => {
    const res = await spawnAgyTui({
      prompt: "Prueba segura",
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    const cmdStr = res.command.join(" ");
    expect(cmdStr).not.toContain("--dangerously-skip-permissions");
  });

  it("TL-05: dangerouslySkipPermissions is included only when explicitly true", async () => {
    const res = await spawnAgyTui({
      prompt: "Prueba con skip explícito",
      dangerouslySkipPermissions: true,
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    const cmdStr = res.command.join(" ");
    expect(cmdStr).toContain("--dangerously-skip-permissions");
  });

  it("TL-06: spawnAgyTui generates taskId and binds to monitor coordination prompt", async () => {
    const res = await spawnAgyTui({
      prompt: "Tarea con monitor bus",
      includeMonitorHint: true,
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    expect(res.taskId).toBeDefined();
    expect(res.taskId).toStartWith("task-tui-");
    expect(res.operationId).toBeDefined();
    expect(res.monitorUrl).toBeDefined();
    expect(res.state).toBe("PREPARED");
    const cmdStr = res.command.join(" ");
    expect(cmdStr).toContain("TASK_ID:");
    expect(cmdStr).toContain(res.taskId!);
  });

  it("TL-07: spawnAgyTui accepts custom taskId and operationId", async () => {
    const res = await spawnAgyTui({
      prompt: "Tarea con ID personalizado",
      taskId: "task-custom-12345",
      operationId: "op-custom-67890",
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    expect(res.taskId).toBe("task-custom-12345");
    expect(res.operationId).toBe("op-custom-67890");
    const cmdStr = res.command.join(" ");
    expect(cmdStr).toContain("task-custom-12345");
    expect(cmdStr).toContain("op-custom-67890");
  });

  it("TL-08: spawnAgyTui injects agent bootstrap protocol with wait-next and WaitMsBeforeAsync", async () => {
    const res = await spawnAgyTui({
      prompt: "Auditar sistema",
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    const cmdStr = res.command.join(" ");
    expect(cmdStr).toContain("PROTOCOLO OPERATIVO AGENTE ISyMCP");
    expect(cmdStr).toContain("monitor wait-next 3600");
    expect(cmdStr).toContain("WaitMsBeforeAsync: 500");
    expect(cmdStr).toContain("monitor respond");
  });
});
