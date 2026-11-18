// tests/mcp-gateway.test.ts — Pruebas unitarias para el Universal Gateway de ISyMCP (estilo REA).
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchIsyMcpAction, ISYMCP_GLOSSARY } from "../src/mcp/gateway";
import { waitForHandoffDelivery } from "../src/handoff/service";
import { defaultOpenSwiftDir } from "../src/openswift/service";

describe("ISyMCP Universal Gateway Suite", () => {
  let prevAllow: string | undefined;
  let prevHome: string | undefined;
  let home: string;

  beforeEach(() => {
    prevAllow = process.env.ISYMCP_ALLOW_HOST_SHELL;
    process.env.ISYMCP_ALLOW_HOST_SHELL = "1";
    // Home aislado: monitor.submit/respond NO deben escribir en el monitor real del operador.
    prevHome = process.env.CODEX_WEB_HTTP_HOME;
    home = mkdtempSync(join(tmpdir(), "gw-suite-"));
    process.env.CODEX_WEB_HTTP_HOME = home;
  });
  afterEach(() => {
    if (prevAllow === undefined) delete process.env.ISYMCP_ALLOW_HOST_SHELL;
    else process.env.ISYMCP_ALLOW_HOST_SHELL = prevAllow;
    if (prevHome === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
    else process.env.CODEX_WEB_HTTP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
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

  it("GW-13: dispatches openswift.devices and openswift.screenshot cleanly", async () => {
    const prevOpenSwift = process.env.OPENSWIFT_DIR;
    try {
      if (!existsSync(join(defaultOpenSwiftDir(), "openswift", "devices.py"))) {
        const pkg = join(home, "openswift");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(
          join(pkg, "devices.py"),
          [
            "from dataclasses import dataclass",
            "from enum import Enum",
            "class NotchType(Enum): DYNAMIC_ISLAND = 'dynamic_island'",
            "@dataclass",
            "class Device:",
            "  id: str; name: str; idiom: str; width: int; height: int; notch_type: NotchType; has_action_button: bool; has_camera_control: bool",
            "DEVICES = {'iphone-16-pro': Device('iphone-16-pro', 'iPhone 16 Pro', 'phone', 402, 874, NotchType.DYNAMIC_ISLAND, True, True)}",
            "ORIENTATIONS = ('portrait', 'landscape')",
          ].join("\n"),
        );
        writeFileSync(join(pkg, "render.py"), "APPEARANCES = ('dark', 'light')\nFRAMES = {'black': {}}\n");
        writeFileSync(
          join(pkg, "__main__.py"),
          [
            "import json, sys, pathlib",
            "out = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])",
            "out.parent.mkdir(parents=True, exist_ok=True)",
            "out.write_bytes(b'\\x89PNG\\r\\n\\x1a\\n' + b'0' * 128)",
            "print(json.dumps({'ok': True, 'png_path': str(out), 'sha256': 'abc', 'bytes': 136, 'raster_engine': 'builtin', 'devices': ['iphone-16-pro'], 'problems': [], 'tree': {'kind': 'VStack'}}))",
          ].join("\n"),
        );
        process.env.OPENSWIFT_DIR = home;
      }

      const devs = await dispatchIsyMcpAction("openswift.devices");
      expect(devs.ok).toBe(true);
      expect(Array.isArray((devs.result as any).devices)).toBe(true);

      const shot = await dispatchIsyMcpAction("openswift.screenshot", {
        source: 'import SwiftUI\nstruct V: View { var body: some View { Text("Hola iPhone") } }',
        device: "iphone-16-pro",
        scale: 1,
      });
      expect(shot.ok).toBe(true);
      const res = shot.result as any;
      expect(res.png_path).toContain(".png");
      expect(res._mcp_image?.mimeType).toBe("image/png");
      expect(res._mcp_image?.data.length).toBeGreaterThan(50);
    } finally {
      if (prevOpenSwift === undefined) delete process.env.OPENSWIFT_DIR;
      else process.env.OPENSWIFT_DIR = prevOpenSwift;
    }
  });

  it("GW-14: loads NVAPI compacted handoff + verifies files + runs ziggrep via handoff.load", async () => {
    const vault = join(home, "compacted");
    const ws = join(home, "ws");
    mkdirSync(vault, { recursive: true });
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(
      join(ws, "src", "demo.py"),
      "def start_async_compaction():\n    return 'ok'\n",
    );
    writeFileSync(
      join(vault, "ab6bd0b4_handoff.md"),
      [
        "# 🗜️ Handoff Compactado por NVIDIA NIM (`nvidia/nemotron-3-ultra-550b-a55b`)",
        "- **Conversación original:** `ab6bd0b4-3bd5-4a81-a1c3-c659ecd67f02` (Dashboard Multi-Sesión Para AGY)",
        `- **Workspace:** \`${ws}\``,
        "- **Reducción de contexto:** `~100,000 tokens` -> `~800 tokens` (**99.2% ahorrado**)",
        "",
        "## 2. TRABAJO COMPLETADO",
        "- Revisar `src/demo.py` y `start_async_compaction`.",
      ].join("\n"),
    );

    const listed = await dispatchIsyMcpAction("handoff.list", { compacted_dir: vault });
    expect(listed.ok).toBe(true);
    expect((listed.result as any).count).toBe(1);

    const loaded = await dispatchIsyMcpAction("handoff.load", {
      target: "ab6bd0b4",
      workspace: ws,
      compacted_dir: vault,
    });
    expect(loaded.ok).toBe(true);
    const r = loaded.result as any;
    expect(r.conv_id).toBe("ab6bd0b4-3bd5-4a81-a1c3-c659ecd67f02");
    expect(r.title).toBe("Dashboard Multi-Sesión Para AGY");
    expect(r.referenced_files.some((f: any) => f.path === "src/demo.py" && f.exists === true)).toBe(true);
    expect(r.ziggrep_matches).toContain("start_async_compaction");

    const sc = await dispatchIsyMcpAction("handoff.self_compact", {
      conv_id: "ab6bd0b4",
      cwd: ws,
      resume_prompt: "Seguir con pruebas",
      dryRun: true,
    });
    expect(sc.ok).toBe(true);
    const scr = sc.result as any;
    expect(scr.in_place).toBe(true);
    expect(scr.model).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(scr.command.join(" ")).toContain("self-compact ab6bd0b4 --bg");

    // Reactive file monitor wakes immediately once Nemotron writes <id>_handoff.md
    const delayedDir = join(home, "delayed-vault");
    mkdirSync(delayedDir, { recursive: true });
    setTimeout(() => {
      writeFileSync(join(delayedDir, "deadbeef_handoff.md"), "# Handoff listo\n");
    }, 80);
    const waited = await waitForHandoffDelivery({
      short_id: "deadbeef",
      compacted_dir: delayedDir,
      since_ms: Date.now() - 100,
      timeout_ms: 4000,
    });
    expect(waited.ok).toBe(true);
    expect(waited.handoff_file).toContain("deadbeef_handoff.md");
  });
});
