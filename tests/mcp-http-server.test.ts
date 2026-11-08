// tests/mcp-http-server.test.ts — Pruebas de integración para el servidor MCP Streamable HTTP (SSE) de CC-04
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type http from "node:http";
import { createMcpHttpServer } from "../src/mcp/http-server";

describe("CC-04 — MCP Streamable HTTP (SSE) Suite", () => {
  const TEST_PORT = 8795;
  let server: http.Server;

  beforeAll(async () => {
    server = createMcpHttpServer(TEST_PORT, "127.0.0.1");
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, "127.0.0.1", () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("SSE-01: Health check retorna transporte mcp-sse y las 4 herramientas autorizadas", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.transport).toBe("mcp-sse");
    expect(body.tools_count).toBe(4);
    expect(body.allowed_tools).toEqual([
      "isymcp_get_overview",
      "isymcp_get_glossary",
      "isymcp_get_tasks",
      "isymcp_get_protocol",
    ]);
  });

  it("SSE-02: Rechaza peticiones con Host header ajeno (DNS Rebinding)", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`, {
      headers: { Host: "evil-attacker.com" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("forbidden_host");
  });

  it("SSE-03: Rechaza orígenes no autorizados por CORS", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`, {
      headers: { Origin: "http://malicious-site.com" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("forbidden_origin");
  });

  it("SSE-04: Inicia stream SSE y emite evento de endpoint con sessionId", async () => {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/sse`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let received = "";
    while (true) {
      const { value, done } = await reader!.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
      if (received.includes("endpoint") || received.includes("/messages")) {
        break;
      }
    }

    controller.abort();
    expect(received).toContain("/messages");
    expect(received).toContain("sessionId=");
  });

  it("SSE-05: Petición POST a /messages sin sessionId válido es rechazada", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("invalid_session");
  });
});
