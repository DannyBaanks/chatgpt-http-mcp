// tests/cc-03-authority.test.ts — Pruebas de Transporte, Aislamiento de Autoridad y Controles Negativos para CC-03
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "./helpers/mcp-client";
import { dispatchControlCenterAction } from "../src/control-center/service";

describe("CC-03 — Suite Integral: Transporte, Aislamiento de Autoridad y E2E", () => {
  let home: string;
  let client: McpClient;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "isyco-cc03-"));
    // Un solo cliente persistente conectado a src/mcp/readonly.ts sobre stdio
    client = await McpClient.start(home, {}, "src/mcp/readonly.ts", []);
  }, 30_000);

  afterAll(() => {
    client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("Fase A: Identidad del Transporte", () => {
    it("CC03-TR-01: Resident Monitor (:8799) es un servidor REST y rechaza transporte MCP", async () => {
      // 1. Endpoint REST nativo /ready responde OK
      const readyRes = await fetch("http://127.0.0.1:8799/ready", { signal: AbortSignal.timeout(3000) });
      expect(readyRes.status).toBe(200);
      const readyJson = (await readyRes.json()) as any;
      expect(readyJson.ok).toBe(true);
      expect(readyJson.service).toBe("isymcp-remote-monitor");

      // 2. Solicitud MCP JSON-RPC a :8799 es rechazada con HTTP 404 (no implementa MCP sobre HTTP)
      const mcpHttpRes = await fetch("http://127.0.0.1:8799/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        }),
        signal: AbortSignal.timeout(3000),
      });
      expect(mcpHttpRes.status).toBe(404);

      // 3. Intento de ejecución directa en el monitor /isymcp/monitor/exec es bloqueado con HTTP 403
      const execRes = await fetch("http://127.0.0.1:8799/isymcp/monitor/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "whoami" }),
        signal: AbortSignal.timeout(3000),
      });
      expect(execRes.status).toBe(403);
      const execJson = (await execRes.json()) as any;
      expect(execJson.reason).toContain("queue_lease_cannot_execute");
    });

    it("CC03-TR-02: Panel Server (:8798) es un servidor HTTP Web/REST protegido en loopback", async () => {
      const readyRes = await fetch("http://127.0.0.1:8798/ready", { signal: AbortSignal.timeout(3000) });
      expect(readyRes.status).toBe(200);

      const ccHtmlRes = await fetch("http://127.0.0.1:8798/control-center", { signal: AbortSignal.timeout(3000) });
      expect(ccHtmlRes.status).toBe(200);
      const html = await ccHtmlRes.text();
      expect(html).toContain("ISyMCP Panel");
    });
  });

  describe("Fase B: Aislamiento de Autoridad & Controles Negativos (Read-Only MCP Server)", () => {
    it("CC03-AUTH-01: El catálogo de herramientas expone EXCLUSIVAMENTE las 4 de solo lectura", async () => {
      const tools = await client.listTools();
      const names = tools.map((t) => t.name).sort();

      // Comprobar catálogo exacto
      expect(names).toEqual([
        "isymcp_get_glossary",
        "isymcp_get_overview",
        "isymcp_get_protocol",
        "isymcp_get_tasks",
      ]);

      // Ninguna herramienta de mutación, shell o ejecución existe en el catálogo
      expect(names).not.toContain("shell_exec");
      expect(names).not.toContain("spawn_agy_tui");
      expect(names).not.toContain("codex_exec");
      expect(names).not.toContain("codex_apply_patch");
      expect(names).not.toContain("isymcp"); // Gateway universal tampoco registrado
      expect(names).not.toContain("github_exec");
    });

    it("CC03-AUTH-02: [Control Negativo 1] Intento de invocar 'shell_exec' es RECHAZADO por el backend", async () => {
      const res = await client.call("shell_exec", { command: "echo INTRUSION" });
      expect(res.isError).toBe(true);
      expect(res.error).toBeDefined();
      expect(String(res.error).toLowerCase()).toContain("tool");
    });

    it("CC03-AUTH-03: [Control Negativo 2] Intento de invocar 'spawn_agy_tui' es RECHAZADO por el backend", async () => {
      const res = await client.call("spawn_agy_tui", { prompt: "Malicious prompt" });
      expect(res.isError).toBe(true);
      expect(res.error).toBeDefined();
      expect(String(res.error).toLowerCase()).toContain("tool");
    });

    it("CC03-AUTH-04: [Control Negativo 3] Intento de invocar 'codex_exec' es RECHAZADO por el backend", async () => {
      const res = await client.call("codex_exec", { command: ["ls", "-la"] });
      expect(res.isError).toBe(true);
      expect(res.error).toBeDefined();
      expect(String(res.error).toLowerCase()).toContain("tool");
    });

    it("CC03-AUTH-05: [Control Negativo 4] Intento de invocar 'isymcp' gateway universal es RECHAZADO por el backend", async () => {
      const res = await client.call("isymcp", { action: "shell.exec", arguments: { command: "id" } });
      expect(res.isError).toBe(true);
      expect(res.error).toBeDefined();
      expect(String(res.error).toLowerCase()).toContain("tool");
    });

    it("CC03-AUTH-06: [Control Negativo 5] Dispatcher REST bloquea comandos peligrosos sin confirmación", async () => {
      const unconfirmed = await dispatchControlCenterAction("shell.exec", { command: "whoami" }, { confirmed: false });
      expect(unconfirmed.ok).toBe(false);
      expect(unconfirmed.requires_confirmation).toBe(true);

      const aliasUnconfirmed = await dispatchControlCenterAction("exec", { command: "whoami" });
      expect(aliasUnconfirmed.ok).toBe(false);
      expect(aliasUnconfirmed.requires_confirmation).toBe(true);
    });
  });

  describe("Fase D: Prueba End-to-End con Datos Vivos y Sanitizados", () => {
    it("CC03-E2E-01: isymcp_get_overview retorna estado vivo del sistema sin secretos", async () => {
      const res = await client.call("isymcp_get_overview", {});
      expect(res.services).toBeDefined();
      expect(Array.isArray(res.services)).toBe(true);
      expect(res.monitor).toBeDefined();
      expect((res.monitor as any).status).toBe("up");
      expect(res.bridge).toBeDefined();
      expect(res.metrics).toBeDefined();
      expect((res.metrics as any).memoryRssMb).toBeGreaterThan(0);

      const rawStr = JSON.stringify(res);
      expect(rawStr).not.toContain("ISYMCP_SECRET");
      expect(rawStr).not.toContain("Bearer ");
    }, 30_000);

    it("CC03-E2E-02: isymcp_get_glossary retorna contratos y familias tipadas", async () => {
      const res = await client.call("isymcp_get_glossary", {});
      expect(res.gateway).toBe("isymcp");
      expect(res.families).toBeDefined();
      expect((res.families as any).tui).toBeDefined();
      expect((res.families as any).monitor).toBeDefined();
    }, 30_000);

    it("CC03-E2E-03: isymcp_get_tasks lee tareas vivas desde SQLite WAL", async () => {
      const res = await client.call("isymcp_get_tasks", { limit: 5 });
      expect(Array.isArray(res)).toBe(true);
      expect((res as unknown as any[]).length).toBeLessThanOrEqual(5);
    }, 30_000);

    it("CC03-E2E-04: isymcp_get_protocol retorna documento Markdown oficial", async () => {
      const res = await client.call("isymcp_get_protocol", {});
      expect(res.text).toBeDefined();
      expect(String(res.text)).toContain("PROTOCOLO OFICIAL DE COORDINACIÓN DE AGENTES");
      expect(String(res.text)).toContain("monitor wait-next 3600");
    }, 30_000);
  });
});
