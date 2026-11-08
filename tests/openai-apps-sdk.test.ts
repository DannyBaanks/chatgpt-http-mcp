// tests/openai-apps-sdk.test.ts — Validación del contrato OpenAI Apps SDK (ASDK) y vistas MCP-UI.

import { describe, expect, test } from "bun:test";
import { createReadOnlyMcpServer } from "../src/mcp/readonly";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { renderControlCenterEmbeddedHtml } from "../src/control-center/ui";

describe("OpenAI Apps SDK (ASDK) MCP App View & Resources Contract", () => {
  test("renderControlCenterEmbeddedHtml produce un documento HTML autosuficiente sin dependencias externas", () => {
    const html = renderControlCenterEmbeddedHtml();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>ISyMCP Control Center — OpenAI Apps SDK View</title>");
    expect(html).toContain("cc-root");
    expect(html).toContain("openai:app-ready");
    expect(html).toContain("openai:set-theme");
    expect(html).toContain("cc-dashboard");
    expect(html).toContain("cc-cli-deck");
    expect(html).toContain("cc-monitor");
    expect(html).not.toContain("https://cdn.");
    expect(html).not.toContain("http://");
  });

  test("Servidor MCP de solo lectura expone los recursos ui:// requeridos por Apps SDK", async () => {
    const server = createReadOnlyMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "test-chatgpt-client", version: "1.0.0" }, { capabilities: {} });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // 1. Listar recursos
    const resources = await client.listResources();
    expect(resources.resources).toBeDefined();

    const uris = resources.resources.map((r) => r.uri);
    expect(uris).toContain("ui://isymcp/control-center");
    expect(uris).toContain("ui://widgets/control-center");
    expect(uris).toContain("isymcp://protocol/agents.md");

    // 2. Leer recurso UI de la Página Conectada
    const readUi = await client.readResource({ uri: "ui://isymcp/control-center" });
    expect(readUi.contents).toBeDefined();
    expect(readUi.contents.length).toBe(1);

    const uiContent = readUi.contents[0] as { uri: string; mimeType: string; text: string };
    expect(uiContent.uri).toBe("ui://isymcp/control-center");
    expect(uiContent.mimeType).toBe("text/html");
    expect(uiContent.text).toContain("<!doctype html>");
    expect(uiContent.text).toContain("openai:app-ready");

    // 3. Leer alias de compatibilidad MCP-UI
    const readWidget = await client.readResource({ uri: "ui://widgets/control-center" });
    expect(readWidget.contents[0].uri).toBe("ui://widgets/control-center");
    expect((readWidget.contents[0] as any).mimeType).toBe("text/html");

    // 4. Listar herramientas
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("isymcp_get_overview");
    expect(toolNames).toContain("isymcp_get_glossary");
    expect(toolNames).toContain("isymcp_get_tasks");
    expect(toolNames).toContain("isymcp_get_protocol");
    expect(toolNames).toContain("isymcp_open_control_center");

    // 5. Invocar herramienta de apertura de UI y verificar metadatos de Apps SDK
    const openRes = await client.callTool({
      name: "isymcp_open_control_center",
      arguments: { tab: "cli" },
    });

    expect(openRes.content).toBeDefined();
    const openContent = openRes.content as Array<{ type: string; text: string }>;
    expect(openContent[0].text).toContain("ISyMCP Control Center desplegado");

    // Verificación de metadatos Apps SDK
    const meta = (openRes as any)._meta;
    expect(meta).toBeDefined();
    expect(meta["ui.resourceUri"]).toBe("ui://isymcp/control-center");
    expect(meta["openai/outputTemplate"]).toBe("ui://isymcp/control-center");
    expect(meta["ui.initialTab"]).toBe("cli");

    // 6. Invocar isymcp_get_overview y verificar enlace a vista UI
    const overviewRes = await client.callTool({
      name: "isymcp_get_overview",
      arguments: {},
    });
    const overviewMeta = (overviewRes as any)._meta;
    expect(overviewMeta).toBeDefined();
    expect(overviewMeta["ui.resourceUri"]).toBe("ui://isymcp/control-center");

    await client.close();
    await server.close();
  });
});
