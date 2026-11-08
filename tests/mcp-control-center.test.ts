// tests/mcp-control-center.test.ts — Pruebas de registro, ejecución e integración de las tools MCP de Control Center
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerControlCenterMcpTools } from "../src/mcp/gateway";
import { McpClient } from "./helpers/mcp-client";

describe("MCP Control Center Tools — Unit Suite", () => {
  it("CC-MCP-01: registers 4 discrete read-only tools on McpServer", () => {
    const server = new McpServer({ name: "test-cc", version: "1.0.0" });
    registerControlCenterMcpTools(server);

    const tools = (server as any)._registeredTools;
    expect(tools).toBeDefined();
    expect(Object.keys(tools)).toContain("isymcp_get_overview");
    expect(Object.keys(tools)).toContain("isymcp_get_glossary");
    expect(Object.keys(tools)).toContain("isymcp_get_tasks");
    expect(Object.keys(tools)).toContain("isymcp_get_protocol");
  });

  it("CC-MCP-02: verifies read-only and non-destructive annotations on all tools", () => {
    const server = new McpServer({ name: "test-cc", version: "1.0.0" });
    registerControlCenterMcpTools(server);

    const tools = (server as any)._registeredTools;
    const toolNames = [
      "isymcp_get_overview",
      "isymcp_get_glossary",
      "isymcp_get_tasks",
      "isymcp_get_protocol",
    ];

    for (const name of toolNames) {
      const tool = tools[name];
      expect(tool).toBeDefined();
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
  });

  it("CC-MCP-03: executes isymcp_get_overview and returns sanitized status", async () => {
    const server = new McpServer({ name: "test-cc", version: "1.0.0" });
    registerControlCenterMcpTools(server);

    const handler = (server as any)._registeredTools["isymcp_get_overview"].handler;
    const res = await handler({});

    expect(res.content).toBeDefined();
    expect(res.content[0].type).toBe("text");
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.services).toBeDefined();
    expect(parsed.monitor).toBeDefined();
    expect(parsed.bridge).toBeDefined();
    expect(parsed.metrics).toBeDefined();
    // Zero secret tokens
    expect(res.content[0].text).not.toContain("ISYMCP_SECRET");
    expect(res.content[0].text).not.toContain("bearer");
  });

  it("CC-MCP-04: executes isymcp_get_glossary and returns complete family catalog", async () => {
    const server = new McpServer({ name: "test-cc", version: "1.0.0" });
    registerControlCenterMcpTools(server);

    const handler = (server as any)._registeredTools["isymcp_get_glossary"].handler;
    const res = await handler({});

    expect(res.content[0].type).toBe("text");
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.gateway).toBe("isymcp");
    expect(parsed.families).toBeDefined();
    expect(parsed.families.tui).toBeDefined();
    expect(parsed.families.monitor).toBeDefined();
    expect(parsed.families.github).toBeDefined();
    expect(parsed.families.protocol).toBeDefined();
  });

  it("CC-MCP-05: executes isymcp_get_tasks with limit and returns SQLite tasks", async () => {
    const server = new McpServer({ name: "test-cc", version: "1.0.0" });
    registerControlCenterMcpTools(server);

    const handler = (server as any)._registeredTools["isymcp_get_tasks"].handler;
    const res = await handler({ limit: 5 });

    expect(res.content[0].type).toBe("text");
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeLessThanOrEqual(5);
  });

  it("CC-MCP-06: executes isymcp_get_protocol and returns markdown document", async () => {
    const server = new McpServer({ name: "test-cc", version: "1.0.0" });
    registerControlCenterMcpTools(server);

    const handler = (server as any)._registeredTools["isymcp_get_protocol"].handler;
    const res = await handler({});

    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("PROTOCOLO OFICIAL DE COORDINACIÓN DE AGENTES");
    expect(res.content[0].text).toContain("monitor wait-next 3600");
  });
});

describe("MCP Control Center Tools — End-to-End stdio Suite", () => {
  let home: string;
  let client: McpClient;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "isyco-cc-mcp-"));
    client = await McpClient.start(home);
  }, 30_000);

  afterAll(() => {
    client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("CC-MCP-07: lists all 4 Control Center tools in tools/list via JSON-RPC stdio", async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("isymcp_get_overview");
    expect(names).toContain("isymcp_get_glossary");
    expect(names).toContain("isymcp_get_tasks");
    expect(names).toContain("isymcp_get_protocol");

    const overviewTool = tools.find((t) => t.name === "isymcp_get_overview");
    expect(overviewTool?.annotations?.readOnlyHint).toBe(true);
  });

  it("CC-MCP-08: invokes isymcp_get_overview via tools/call over live stdio", async () => {
    const res = await client.call("isymcp_get_overview", {});
    expect(res.services).toBeDefined();
    expect(res.monitor).toBeDefined();
    expect(res.bridge).toBeDefined();
    expect(res.metrics).toBeDefined();
  });

  it("CC-MCP-09: invokes isymcp_get_glossary via tools/call over live stdio", async () => {
    const res = await client.call("isymcp_get_glossary", {});
    expect(res.gateway).toBe("isymcp");
    expect(res.families).toBeDefined();
  });

  it("CC-MCP-10: invokes isymcp_get_tasks via tools/call over live stdio", async () => {
    const res = await client.call("isymcp_get_tasks", { limit: 3 });
    expect(Array.isArray(res)).toBe(true);
    expect((res as unknown as any[]).length).toBeLessThanOrEqual(3);
  });

  it("CC-MCP-11: invokes isymcp_get_protocol via tools/call over live stdio", async () => {
    const res = await client.call("isymcp_get_protocol", {});
    expect(res.text).toBeDefined();
    expect(String(res.text)).toContain("PROTOCOLO OFICIAL DE COORDINACIÓN DE AGENTES");
  });
});
