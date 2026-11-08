// tests/mcp-gateway.test.ts — Pruebas unitarias para el Universal Gateway de ISyMCP (estilo REA).
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { dispatchIsyMcpAction, ISYMCP_GLOSSARY } from "../src/mcp/gateway";

describe("ISyMCP Universal Gateway Suite", () => {
  let prevAllow: string | undefined;

  beforeEach(() => {
    prevAllow = process.env.ISYMCP_ALLOW_HOST_SHELL;
    process.env.ISYMCP_ALLOW_HOST_SHELL = "1";
  });
  afterEach(() => {
    if (prevAllow === undefined) delete process.env.ISYMCP_ALLOW_HOST_SHELL;
    else process.env.ISYMCP_ALLOW_HOST_SHELL = prevAllow;
  });

  it("GW-01: returns the glossary when action is empty or 'glossary'", async () => {
    const resEmpty = await dispatchIsyMcpAction("");
    expect(resEmpty.ok).toBe(true);
    expect((resEmpty.result as any).gateway).toBe("isymcp");
    expect((resEmpty.result as any).families.tui).toBeDefined();
    expect((resEmpty.result as any).families.github).toBeDefined();
    expect((resEmpty.result as any).families.monitor).toBeDefined();
    expect((resEmpty.result as any).families.protocol).toBeDefined();

    const resGlossary = await dispatchIsyMcpAction("glossary");
    expect(resGlossary.ok).toBe(true);
    expect((resGlossary.result as any).families).toEqual(ISYMCP_GLOSSARY.families);
  });

  it("GW-02: describes a specific tool contract", async () => {
    const res = await dispatchIsyMcpAction("describe", { name: "tui.spawn" });
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.action).toBe("tui.spawn");
    expect(result.family).toBe("tui");
    expect(result.parameters.prompt).toBeDefined();

    const resProtocol = await dispatchIsyMcpAction("describe", { name: "protocol.read" });
    expect(resProtocol.ok).toBe(true);
    expect((resProtocol.result as any).family).toBe("protocol");
  });

  it("GW-03: fails describing unknown action with helpful error", async () => {
    const res = await dispatchIsyMcpAction("describe", { name: "unknown.tool" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Acción desconocida");
    expect(res.error).toContain("glossary");
  });

  it("GW-04: returns agent bootstrap protocol via protocol action", async () => {
    const res = await dispatchIsyMcpAction("protocol");
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.protocol_document).toBe("isymcp://protocol/agents.md");
    expect(result.markdown).toContain("PROTOCOLO OFICIAL DE COORDINACIÓN DE AGENTES");
    expect(result.markdown).toContain("monitor wait-next 3600");
  });

  it("GW-05: dispatches tui.spawn in dry-run mode with bootstrap protocol injection", async () => {
    const res = await dispatchIsyMcpAction("tui.spawn", {
      prompt: "Verificar integridad de la arquitectura",
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.ok).toBe(true);
    expect(result.taskId).toStartWith("task-tui-");
    expect(result.operationId).toStartWith("op-tui-");
    const cmdStr = (result.command as string[]).join(" ");
    expect(cmdStr).toContain("PROTOCOLO OPERATIVO AGENTE ISyMCP");
    expect(cmdStr).toContain("monitor wait-next 3600");
    expect(cmdStr).toContain("WaitMsBeforeAsync: 500");
  });

  it("GW-06: dispatches monitor.status cleanly", async () => {
    const res = await dispatchIsyMcpAction("monitor.status");
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.monitor_url).toBeDefined();
    expect(typeof result.active_leases_count).toBe("number");
    expect(typeof result.recent_tasks_count).toBe("number");
  });

  it("GW-07: dispatches monitor.tasks cleanly", async () => {
    const res = await dispatchIsyMcpAction("monitor.tasks", { limit: 5 });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.result)).toBe(true);
  });

  it("GW-08: returns error for unsupported action", async () => {
    const res = await dispatchIsyMcpAction("nonexistent.family.action");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Acción no soportada");
  });

  it("GW-09: dispatches shell.exec through universal gateway", async () => {
    const res = await dispatchIsyMcpAction("shell.exec", { command: "echo 'GATEWAY_SHELL_TEST'" });
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.stdout).toContain("GATEWAY_SHELL_TEST");
    expect(result.exit_code).toBe(0);
  });

  it("GW-10: dispatches monitor.submit cleanly", async () => {
    const res = await dispatchIsyMcpAction("monitor.submit", {
      description: "Test task submission via gateway",
      kind: "diagnostics",
    });
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.task_id).toBeDefined();
    expect(result.description).toBe("Test task submission via gateway");
  });

  it("GW-11: resolves common aliases in describe", async () => {
    const resShell = await dispatchIsyMcpAction("describe", { name: "shell" });
    expect(resShell.ok).toBe(true);
    expect((resShell.result as any).action).toBe("shell.exec");

    const resTui = await dispatchIsyMcpAction("describe", { name: "tui" });
    expect(resTui.ok).toBe(true);
    expect((resTui.result as any).action).toBe("tui.spawn");

    const resProto = await dispatchIsyMcpAction("describe", { name: "protocol" });
    expect(resProto.ok).toBe(true);
    expect((resProto.result as any).action).toBe("protocol.read");
  });

  it("GW-12: preserves shell execution output and exit code on failure", async () => {
    const res = await dispatchIsyMcpAction("shell.exec", { command: "echo 'FAIL_STDOUT' && exit 42" });
    expect(res.ok).toBe(false);
    expect(res.result).toBeDefined();
    const result = res.result as any;
    expect(result.stdout).toContain("FAIL_STDOUT");
    expect(result.exit_code).toBe(42);
  });
});
