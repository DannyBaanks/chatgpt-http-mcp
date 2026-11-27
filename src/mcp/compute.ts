// src/mcp/compute.ts — Servidor MCP stdio dedicado `isymcp-compute` (cero Electron).
// Expone tools directas para cómputo remoto async (Windows Xeon / WSL2 / RTX 4060), Link E2E y Hive headless.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerComputeMcpTools } from "../compute/register";
import { serverIcon } from "./icon";

const server = new McpServer(
  { name: "isymcp-compute", version: "1.1.0", icons: [serverIcon()] },
  {
    instructions:
      "Despacha procesos asíncronos (CPU, Windows nativo, WSL2/CUDA RTX 4060) y coordina Hive/Link con máquinas emparejadas. " +
      "Usa `compute_peers` y `compute_telemetry` para ver recursos disponibles, y `compute_run` (con `wait_ms` opcional para comandos rápidos) para ejecutar jobs remotos.",
  },
);
registerComputeMcpTools(server);
await server.connect(new StdioServerTransport());
