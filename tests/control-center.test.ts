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
  executeIsyMcpCli,
  isCliCommandDestructive,
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
  }, 15000);
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

  test("CC-06: shell.exec con challenge-response de OperatorGrant ejecuta en el host", async () => {
    // 1. Sin grant: recibe 403 challenge con operator_grant
    const challenge = await dispatchControlCenterAction(
      "shell.exec",
      { command: "echo cc_verified" }
    );
    expect(challenge.ok).toBe(false);
    expect(challenge.requires_confirmation).toBe(true);
    expect(challenge.operator_grant).toBeDefined();

    // 2. Con grant firmado: ejecuta legítimamente
    const res = await dispatchControlCenterAction(
      "shell.exec",
      { command: "echo cc_verified" },
      { operator_grant: challenge.operator_grant }
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
      "cc-cli-deck",
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

describe("ISyMCP Control Center — Ejecución Interactiva de Comandos CLI", () => {
  test("CC-11: executeIsyMcpCli ejecuta comando seguro ('version') y devuelve salida real", async () => {
    const res = await executeIsyMcpCli("version");
    expect(res.ok).toBe(true);
    expect(res.exit_code).toBe(0);
    expect(res.stdout).toContain("isymcp v");
    expect(res.full_command).toBe("isymcp version");
    expect(res.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("CC-12: isCliCommandDestructive detecta correctamente comandos peligrosos", () => {
    expect(isCliCommandDestructive("down").isDestructive).toBe(true);
    expect(isCliCommandDestructive("server", ["stop"]).isDestructive).toBe(true);
    expect(isCliCommandDestructive("tunnel", ["stop"]).isDestructive).toBe(true);
    expect(isCliCommandDestructive("exec", ["ls"]).isDestructive).toBe(true);
    expect(isCliCommandDestructive("sh", ["pwd"]).isDestructive).toBe(true);
    expect(isCliCommandDestructive("tui", ["spawn", "accept-edits"]).isDestructive).toBe(true);

    // Comandos seguros
    expect(isCliCommandDestructive("status").isDestructive).toBe(false);
    expect(isCliCommandDestructive("doctor").isDestructive).toBe(false);
    expect(isCliCommandDestructive("tree").isDestructive).toBe(false);
    expect(isCliCommandDestructive("version").isDestructive).toBe(false);
    expect(isCliCommandDestructive("tunnel", ["status"]).isDestructive).toBe(false);
    expect(isCliCommandDestructive("monitor", ["tasks"]).isDestructive).toBe(false);
    expect(isCliCommandDestructive("tui", ["list"]).isDestructive).toBe(false);
  });

  test("CC-13: executeIsyMcpCli bloquea comando destructivo ('down') sin confirmación explícita (fail-closed)", async () => {
    const res = await executeIsyMcpCli("down", [], { confirmed: false });
    expect(res.ok).toBe(false);
    expect(res.requires_confirmation).toBe(true);
    expect(res.warning).toContain("Detener todos los servicios");
    expect(res.exit_code).toBe(1);
    expect(res.stderr).toContain("Bloqueado por seguridad");
  });

  test("CC-14: Endpoint POST /api/control-center/cli responde 200 para comandos seguros y 403 para destructivos sin confirmación", async () => {
    // 1. Comando seguro
    const reqVersion = new Request("http://127.0.0.1:8798/api/control-center/cli", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "version" }),
    });
    const resVersion = await handleControlCenterApi(reqVersion, new URL(reqVersion.url), "59999");
    expect(resVersion.status).toBe(200);
    const dataVersion = await resVersion.json();
    expect(dataVersion.ok).toBe(true);
    expect(dataVersion.stdout).toContain("isymcp v");

    // 2. Comando destructivo sin confirmación
    const reqDown = new Request("http://127.0.0.1:8798/api/control-center/cli", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "down", confirmed: false }),
    });
    const resDown = await handleControlCenterApi(reqDown, new URL(reqDown.url), "59999");
    expect(resDown.status).toBe(403);
    const dataDown = await resDown.json();
    expect(dataDown.requires_confirmation).toBe(true);
  });

  test("CC-15: Vista renderizada contiene la sección 'cc-cli-deck', los botones de comandos y la consola terminal", () => {
    const viewHtml = renderControlCenterView();

    // Sección de comandos CLI y navegación
    expect(viewHtml).toContain('id="cc-cli-deck"');
    expect(viewHtml).toContain('data-target="cc-cli-deck"');

    // Consola terminal embebida y runner libre
    expect(viewHtml).toContain('id="cc-cli-console"');
    expect(viewHtml).toContain('id="cc-cli-custom-input"');
    expect(viewHtml).toContain('id="cc-cli-run-btn"');
    expect(viewHtml).toContain('id="cc-cli-status-badge"');
    expect(viewHtml).toContain('id="cc-cli-confirm-box"');

    // Botones de ejecución de comandos clave
    expect(viewHtml).toContain("ccExecuteCliCommand('doctor')");
    expect(viewHtml).toContain("ccExecuteCliCommand('status')");
    expect(viewHtml).toContain("ccExecuteCliCommand('tree')");
    expect(viewHtml).toContain("ccExecuteCliCommand('version')");
    expect(viewHtml).toContain("ccExecuteCliCommand('up')");
    expect(viewHtml).toContain("ccExecuteCliCommand('down')");
    expect(viewHtml).toContain("ccExecuteCliCommand('server', ['start'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('server', ['stop'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('tunnel', ['status'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('tunnel', ['connect'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('tunnel', ['stop'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('monitor', ['status'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('monitor', ['tasks'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('tui', ['list'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('github', ['status'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('github', ['whoami'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('media', ['list'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('comfy', ['status'])");
    expect(viewHtml).toContain("ccExecuteCliCommand('models')");
    expect(viewHtml).toContain("ccExecuteCliCommand('fuzz'");
  });
});
