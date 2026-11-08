# CC-03 — Auditoría de Identidad del Transporte (Fase A)

**Fecha:** 2026-11-07  
**Auditor:** Antigravity (AGY) para GPT-6 & Danny Baanks  
**Estado:** `DEMONSTRATED`  
**Referencia de Código:** `src/remote-monitor.ts`, `src/panel.ts`, `src/server.ts`, `src/mcp/readonly.ts`, `src/mcp/main.ts`

---

## 1. Resumen Ejecutivo de la Red Loopback

El entorno local de ISyMCP opera sobre una arquitectura segmentada en loopback (`127.0.0.1`), donde conviven **tres tipos de protocolos distintos**:
1. **REST HTTP APIs:** Servicios de orquestación, cola SQLite WAL y monitor (`:8799`, `:8798`, `:8791`).
2. **Model Context Protocol (MCP) sobre `stdio`:** Protocolo binario/JSON-RPC estricto (`src/mcp/readonly.ts` y `src/mcp/main.ts`).
3. **Túnel Seguro de ChatGPT / Cloudflare (`tunnel-client`):** Agente que puentea el transporte remoto de OpenAI hacia el proceso MCP local en `stdio`.

> [!IMPORTANT]
> **El puerto `127.0.0.1:8799` NO es un servidor MCP.** Es el demonio continuo del Resident Monitor que expone una API REST para SQLite WAL. Cualquier intento de enviar tramas JSON-RPC MCP a `:8799` falla con `HTTP 404 {"error":"not_found"}`.

---

## 2. Matriz de Transporte e Identidad de Endpoints

| Endpoint / Servicio | Puerto / Transporte | Protocolo Wire | Propósito | ¿Acepta MCP JSON-RPC? |
|---|---|---|---|---|
| **Resident Monitor Daemon** | `127.0.0.1:8799` | HTTP 1.1 / JSON REST | Buzón persistente SQLite WAL, webhooks CI, receipts HMAC | ❌ **NO** (Retorna HTTP 404 a `initialize`) |
| **ISyMCP Web Panel & Control Center** | `127.0.0.1:8798` | HTTP 1.1 / HTML + REST | UI gráfica de Danny, API de monitoreo y formularios tipados | ❌ **NO** (Servidor Web con auth local) |
| **ISyMCP Core Bridge** | `127.0.0.1:8791` | HTTP 1.1 / JSON REST | Comunicación con la sesión de ChatGPT, SSE de turnos | ❌ **NO** (Bridge HTTP de orquestación) |
| **ISyMCP Control Center MCP Server** | `stdio` (`src/mcp/readonly.ts`) | JSON-RPC 2.0 (MCP Spec 2024-11-05) | **Servidor MCP oficial de solo lectura** para ChatGPT | ✅ **SÍ** (Contrato nativo MCP stdio) |
| **ISyMCP Universal MCP Server** | `stdio` (`src/mcp/main.ts`) | JSON-RPC 2.0 (MCP Spec 2024-11-05) | Servidor MCP completo con sandbox Codex, multimedia y shell | ✅ **SÍ** (Para sesiones con token local) |
| **Tunnel Client** | `tunnel-client` runtime | WebSocket / gRPC multiplexado | Conexión saliente a OpenAI / ChatGPT | N/A (Spawnea el MCP server local en stdio) |

---

## 3. Pruebas Empíricas de Transporte (Evidencia Viva)

### Prueba TR-01: Verificación del Resident Monitor (`127.0.0.1:8799`)
- **Comando REST nativo:**
  ```bash
  curl -s http://127.0.0.1:8799/ready
  ```
  **Salida observada (HTTP 200 OK):**
  ```json
  {"ok":true,"service":"isymcp-remote-monitor","pid":846487}
  ```
- **Sondeo MCP JSON-RPC directo contra `:8799`:**
  ```bash
  curl -s -X POST http://127.0.0.1:8799/ -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}'
  ```
  **Salida observada (HTTP 404 Not Found):**
  ```json
  {"error":"not_found"}
  ```
- **Freno de ejecución directa en el monitor:**
  ```bash
  curl -s -X POST http://127.0.0.1:8799/isymcp/monitor/exec -H "Content-Type: application/json" -d '{"command":"id"}'
  ```
  **Salida observada (HTTP 403 Forbidden):**
  ```json
  {"accepted":false,"state":"DENIED","reason":"DENY: queue_lease_cannot_execute"}
  ```

### Prueba TR-02: Verificación del Panel Server (`127.0.0.1:8798`)
- **Comando:**
  ```bash
  curl -s -i http://127.0.0.1:8798/control-center
  ```
  **Salida observada (HTTP 200 OK):**
  Retorna documento HTML con login local protegido: `<title>ISyMCP Panel · Acceso Protegido</title>`.

### Prueba TR-03: Inicialización MCP sobre Stdio (`src/mcp/readonly.ts`)
- **Proceso:** Spawneado mediante `bun src/mcp/readonly.ts` con stdin/stdout pipes.
- **Trama enviada:**
  ```json
  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"chatgpt-client","version":"1.0"}}}
  ```
- **Trama recibida (stdout):**
  ```json
  {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"isymcp-control-center-readonly","version":"1.0.0"}}}
  ```
- **Estado:** Inicialización exitosa bajo la especificación Model Context Protocol 2024-11-05.

---

## 4. Conclusión Epistémica (Fase A)
`DEMONSTRATED`: Se demuestra de forma concluyente que el monitor `:8799` es un endpoint REST para la cola y no un listener MCP. El transporte MCP compatible con ChatGPT debe ser provisto exclusivamente por `src/mcp/readonly.ts` (sobre `stdio` para clientes de escritorio o túneles) o mediante endpoints REST OpenAPI 3.1 mapeados en el servidor web.
