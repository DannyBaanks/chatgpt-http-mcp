#!/usr/bin/env bun
// src/mcp/http-server.ts — Servidor MCP Streamable HTTP (SSE) de solo lectura para ChatGPT (CC-04)
import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createReadOnlyMcpServer } from "./readonly";
import { guardLocalRequest } from "../local-guard";

const PORT = Number(process.env.ISYMCP_MCP_HTTP_PORT || 8794);
const HOST = "127.0.0.1";

export function createMcpHttpServer(port = PORT, host = HOST): http.Server {
  const sessions = new Map<string, { transport: SSEServerTransport; server: any }>();

  const server = http.createServer(async (req, res) => {
    // 1. Guard de seguridad de red en loopback (DNS rebinding, host injection, forbidden origins)
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const hostHeader = req.headers.host ?? "";
    const originHeader = (req.headers.origin as string) ?? "";

    if (!hostHeader.startsWith("127.0.0.1") && !hostHeader.startsWith("localhost")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden_host", message: "Acceso exclusivo en loopback" }));
      return;
    }

    if (originHeader && !originHeader.includes("127.0.0.1") && !originHeader.includes("localhost") && !originHeader.includes("chatgpt.com")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden_origin", message: "Origin no autorizado" }));
      return;
    }

    // Cabeceras CORS seguras para ChatGPT
    res.setHeader("Access-Control-Allow-Origin", originHeader || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 2. Health check
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          transport: "mcp-sse",
          profile: "readonly",
          active_sessions: sessions.size,
          tools_count: 4,
          allowed_tools: [
            "isymcp_get_overview",
            "isymcp_get_glossary",
            "isymcp_get_tasks",
            "isymcp_get_protocol",
          ],
        })
      );
      return;
    }

    // 3. GET /sse — Iniciar sesión SSE Streamable
    if (req.method === "GET" && (url.pathname === "/sse" || url.pathname === "/mcp/sse")) {
      const mcpServer = createReadOnlyMcpServer();
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;

      sessions.set(sessionId, { transport, server: mcpServer });

      req.on("close", () => {
        sessions.delete(sessionId);
      });

      await mcpServer.connect(transport);
      return;
    }

    // 4. POST /messages — Despacho de JSON-RPC a la sesión activa
    if (req.method === "POST" && (url.pathname === "/messages" || url.pathname === "/mcp/messages")) {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_session", message: "Sesión SSE no encontrada o cerrada" }));
        return;
      }

      const active = sessions.get(sessionId)!;
      await active.transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return server;
}

if (import.meta.main) {
  const srv = createMcpHttpServer(PORT, HOST);
  srv.listen(PORT, HOST, () => {
    console.log(`[ISyMCP] Servidor MCP Streamable HTTP (SSE) activo en http://${HOST}:${PORT}/sse`);
    console.log(`[ISyMCP] Herramientas de solo lectura listas para conexión con ChatGPT.`);
  });
}
