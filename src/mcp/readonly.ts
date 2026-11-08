#!/usr/bin/env bun
// src/mcp/readonly.ts — Servidor MCP estricto de solo lectura para integración oficial con ChatGPT (CC-03)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerControlCenterMcpTools } from "./gateway";
import { ISYMCP_AGENT_PROTOCOL_MD } from "../agent-protocol";
import { serverIcon } from "./icon";

/**
 * Crea una instancia de McpServer garantizando aislamiento estricto de solo lectura.
 * Por construcción, NO registra herramientas de shell, spawn, mutación de repositorios
 * ni herramientas auxiliares.
 */
export function createReadOnlyMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "isymcp-control-center-readonly",
      version: "1.0.0",
      icons: [serverIcon()],
    },
    {
      instructions:
        "Servidor MCP oficial de solo lectura de ISyMCP Control Center. Provee inspección de salud, glosario, cola de tareas y protocolo de coordinación. No admite comandos de ejecución, mutación o shell.",
    }
  );

  // Exclusivamente las herramientas de solo lectura y apertura del Control Center
  registerControlCenterMcpTools(server);

  // Recurso oficial: Protocolo de coordinación de agentes
  server.resource(
    "isymcp_agents_protocol",
    "isymcp://protocol/agents.md",
    {
      mimeType: "text/markdown",
      description: "Protocolo oficial de bootstrap para agentes coordinados por ISyMCP y ChatGPT",
    },
    async () => ({
      contents: [
        {
          uri: "isymcp://protocol/agents.md",
          mimeType: "text/markdown",
          text: ISYMCP_AGENT_PROTOCOL_MD,
        },
      ],
    })
  );

  // Recurso oficial OpenAI Apps SDK: Vista interactiva del Control Center (Página Conectada)
  server.resource(
    "isymcp_control_center_ui",
    "ui://isymcp/control-center",
    {
      mimeType: "text/html",
      description: "ISyMCP Control Center Interactive Dashboard and Command Deck (OpenAI Apps SDK View)",
    },
    async () => {
      const { renderControlCenterEmbeddedHtml } = await import("../control-center/ui");
      return {
        contents: [
          {
            uri: "ui://isymcp/control-center",
            mimeType: "text/html",
            text: renderControlCenterEmbeddedHtml(),
          },
        ],
      };
    }
  );

  // Alias estándar de compatibilidad para hosts MCP-UI
  server.resource(
    "isymcp_control_center_widget",
    "ui://widgets/control-center",
    {
      mimeType: "text/html",
      description: "Widget interactivo de ISyMCP Control Center para MCP-UI y clientes compatibles",
    },
    async () => {
      const { renderControlCenterEmbeddedHtml } = await import("../control-center/ui");
      return {
        contents: [
          {
            uri: "ui://widgets/control-center",
            mimeType: "text/html",
            text: renderControlCenterEmbeddedHtml(),
          },
        ],
      };
    }
  );

  return server;
}

const server = createReadOnlyMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
