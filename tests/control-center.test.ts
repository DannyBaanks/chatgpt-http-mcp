// tests/control-center.test.ts — Pruebas unitarias e integración para el ISyMCP Control Center.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getControlCenterOverview,
  getControlCenterGlossary,
  getControlCenterTasks,
  getControlCenterProtocol,
  approveControlCenterTask,
  dispatchControlCenterAction,
} from "../src/control-center/service";
import { handleControlCenterApi } from "../src/control-center/router";
import { renderControlCenterView } from "../src/control-center/ui";
import { renderPanel, buildPanelState } from "../src/panel";
import { openBridgeMonitorStack } from "../src/remote-monitor";

let testEnv: Record<string, string>;

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "isymcp-cc-test-"));
  testEnv = {
    ...process.env,
    CODEX_WEB_HTTP_HOME: home,
    CODEX_WEB_HTTP_MONITOR_DB: join(home, "remote-monitor.sqlite"),
  };
});

describe("ISyMCP Control Center — Servicios y Estado", () => {
  test("CC-01: Overview retorna estructura completa de servicios, monitor y métricas", async () => {
    const overview = await getControlCenterOverview("59999");
    expect(overview.ts).toBeDefined();
    expect(overview.services).toBeArray();
    expect(overview.services.length).toBeGreaterThanOrEqual(4);

    const bridge = overview.services.find((s) => s.id === "bridge");
    expect(bridge).toBeDefined();
    expect(bridge?.status).toBe("down"); // puerto 59999 cerrado en test

    expect(overview.monitor).toBeDefined();
    expect(typeof overview.monitor.totalTasksCount).toBe("number");
    expect(typeof overview.monitor.activeLeasesCount).toBe("number");
    expect(overview.metrics).toBeDefined();
    expect(overview.metrics?.memoryRssMb).toBeGreaterThan(0);
  });

  test("CC-02: Glosario expone todas las familias y contratos tipados sin inventar flags", () => {
    const glossary = getControlCenterGlossary();
    expect(glossary.isymcp_version).toBeDefined();
    expect(glossary.families).toBeDefined();

    const expectedFamilies = ["tui", "github", "monitor", "media", "comfyui", "protocol", "shell", "fuzz"];
    for (const fam of expectedFamilies) {
      expect(glossary.families[fam]).toBeDefined();
      expect(typeof glossary.families[fam].description).toBe("string");
      expect(Object.keys(glossary.families[fam].actions).length).toBeGreaterThan(0);
    }

    // Verificar contrato específico de tui.spawn
    const tuiSpawn = glossary.families.tui.actions["tui.spawn"];
    expect(tuiSpawn).toBeDefined();
    expect(tuiSpawn.parameters.prompt).toContain("string");
    expect(tuiSpawn.parameters.mode).toContain("plan");

    // Verificar contrato de shell.exec
    const shellExec = glossary.families.shell.actions["shell.exec"];
    expect(shellExec).toBeDefined();
    expect(shellExec.parameters.command).toContain("string");
  });

  test("CC-03: Protocolo oficial expone isymcp://protocol/agents.md", () => {
    const protocol = getControlCenterProtocol();
    expect(protocol).toContain("PROTOCOLO OFICIAL DE COORDINACIÓN DE AGENTES");
    expect(protocol).toContain("monitor wait-next 3600");
    expect(protocol).toContain("monitor respond");
  });

  test("CC-04: Lista de tareas refleja el estado en SQLite WAL sin filtrar secretos", () => {
    const { db, queue } = openBridgeMonitorStack(testEnv);
    try {
      const alert = queue.submitAlertTask({
        title: "Test Control Center Alert",
        summary: "Diagnóstico Control Center",
        source: "test",
      });
      expect(alert.accepted).toBe(true);
    } finally {
      db.close();
    }

    const tasks = getControlCenterTasks(10, testEnv);
    expect(tasks).toBeArray();
    expect(tasks.length).toBeGreaterThanOrEqual(1);

    const task = tasks[0];
    expect(task.task_id).toBeDefined();
    expect(task.operation_id).toBeDefined();
    expect(task.kind).toBeDefined();
    expect(task.state).toBeDefined();
    // Jamás debe tener tokens
    expect((task as any).turn_token).toBeUndefined();
    expect((task as any).worker_secret).toBeUndefined();
  });
});

describe("ISyMCP Control Center — Seguridad y Control de Comandos Peligrosos", () => {
  test("CC-05: shell.exec sin confirmación explícita es BLOQUEADO (fail-closed)", async () => {
    const res = await dispatchControlCenterAction(
      "shell.exec",
      { command: "echo peligroso" },
      { confirmed: false }
    );
    expect(res.ok).toBe(false);
    expect(res.requires_confirmation).toBe(true);
    expect(res.warning).toContain("shell");
  });

  test("CC-06: shell.exec con confirmación explícita ejecuta en el host", async () => {
    const res = await dispatchControlCenterAction(
      "shell.exec",
      { command: "echo cc_verified" },
      { confirmed: true }
    );
    expect(res.ok).toBe(true);
    expect(res.requires_confirmation).toBeUndefined();
    expect(String((res.result as any)?.stdout || "")).toContain("cc_verified");
  });

  test("CC-07: tui.spawn con accept-edits sin confirmación es BLOQUEADO", async () => {
    const res = await dispatchControlCenterAction(
      "tui.spawn",
      { prompt: "Editar código", mode: "accept-edits" },
      { confirmed: false }
    );
    expect(res.ok).toBe(false);
    expect(res.requires_confirmation).toBe(true);
  });

  test("CC-08: Acciones de solo lectura ejecutan directamente sin confirmación", async () => {
    const resProtocol = await dispatchControlCenterAction("protocol.read");
    expect(resProtocol.ok).toBe(true);
    expect(String((resProtocol.result as any)?.markdown || "")).toContain("PROTOCOLO OFICIAL");

    const resGlossary = await dispatchControlCenterAction("glossary");
    expect(resGlossary.ok).toBe(true);
  });
});

describe("ISyMCP Control Center — API Router y Renderizado UI", () => {
  test("CC-09: Endpoints API responden con tipos y cabeceras correctas", async () => {
    // 1. Overview
    const reqOverview = new Request("http://127.0.0.1:8798/api/control-center/overview");
    const resOverview = await handleControlCenterApi(reqOverview, new URL(reqOverview.url), "59999");
    expect(resOverview.status).toBe(200);
    const dataOverview = await resOverview.json();
    expect(dataOverview.services).toBeDefined();

    // 2. Glossary
    const reqGlossary = new Request("http://127.0.0.1:8798/api/control-center/glossary");
    const resGlossary = await handleControlCenterApi(reqGlossary, new URL(reqGlossary.url), "59999");
    expect(resGlossary.status).toBe(200);

    // 3. Dispatch con bloqueo 403 por falta de confirmación
    const reqDispatch = new Request("http://127.0.0.1:8798/api/control-center/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "shell.exec", arguments: { command: "ls" }, confirmed: false }),
    });
    const resDispatch = await handleControlCenterApi(reqDispatch, new URL(reqDispatch.url), "59999");
    expect(resDispatch.status).toBe(403);
    const dataDispatch = await resDispatch.json();
    expect(dataDispatch.requires_confirmation).toBe(true);
  });

  test("CC-10: Vista renderizada contiene los 8 tabs requeridos sin dependencias externas", async () => {
    const viewHtml = renderControlCenterView();
    const requiredSections = [
      "cc-dashboard",
      "cc-catalog",
      "cc-monitor",
      "cc-tui",
      "cc-github",
      "cc-media",
      "cc-comfy",
      "cc-fuzz",
    ];

    for (const sec of requiredSections) {
      expect(viewHtml).toContain(`id="${sec}"`);
    }

    // Verificar navegación del panel general
    const state = await buildPanelState("59999");
    const fullPanel = renderPanel(state, "control-center");
    expect(fullPanel).toContain('href="#control-center"');
    expect(fullPanel).toContain('class="tab-control-center"');
    expect(fullPanel).toContain('id="view-control-center"');

    // No debe contener scripts externos
    expect(fullPanel).not.toContain("https://cdn.");
    expect(fullPanel).not.toContain("https://unpkg.");
    expect(fullPanel).not.toContain("https://fonts.");
  });
});
