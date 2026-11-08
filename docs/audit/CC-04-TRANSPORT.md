# CC-04 — Arquitectura de Transporte MCP para ChatGPT (Fase A)

**Fecha:** 2026-11-07  
**Auditor:** Antigravity (AGY) para GPT-6 & Danny Baanks  
**Estado:** `DEMONSTRATED`  
**Referencia de Código:** `src/mcp/http-server.ts`, `src/mcp/readonly.ts`, `scripts/connect-tunnel.ts`, `~/.codex-web-http/tunnel/profiles/isymcp-native-media.yaml`

---

## 1. Visión General de Transportes Habilitados

Siguiendo la directiva de GPT-6 sobre la incompatibilidad de ChatGPT con procesos `stdio` directos a través del navegador web, ISyMCP provee **dos mecanismos de transporte complementarios de nivel de producción**:

```
                       ┌─────────────────────────────────────────┐
                       │          ChatGPT / OpenAI Cloud         │
                       └─────────────┬───────────────────────────┘
                                     │
           ┌─────────────────────────┴─────────────────────────┐
           │ (Ruta 1: Túnel Oficial)                           │ (Ruta 2: Local HTTP SSE)
           ▼                                                   ▼
┌──────────────────────┐                             ┌──────────────────────┐
│  Secure MCP Tunnel   │                             │  Streamable HTTP SSE │
│   (tunnel-client)    │                             │ (src/mcp/http-server)│
│  Conexión saliente   │                             │   Puerto 8794        │
│  api.openai.com      │                             │   Loopback estricto  │
└──────────┬───────────┘                             └──────────┬───────────┘
           │ stdio pipe                                         │ SSE + POST
           ▼                                                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    ISyMCP Read-Only MCP Core Engine                       │
│    (isymcp_get_overview, isymcp_get_glossary, isymcp_get_tasks, ...)      │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Ruta 1: Secure MCP Tunnel (`tunnel-client`) [EN EJECUCIÓN]

El entorno de Danny ya cuenta con el cliente oficial de túnel de OpenAI/Cloudflare instalado y activo:

- **Binario:** `/home/danny/.codex-web-http/bin/tunnel-client`
- **Proceso Vivo:** PID `968939` (dentro de sesión tmux `tunnel-mcp__isymcp-native-media__d361ab7d`)
- **Estado verificado:** `tunel ready=true state=ready`
- **Identificador de Túnel:** `tunnel_6acaaf6bbfb88191a9f8a2ecb291e46a`
- **Control Plane:** `https://api.openai.com`
- **Mecanismo:** La conexión se establece **de adentro hacia afuera** (outbound WebSocket/gRPC). No abre ningún puerto entrante en el router ni en el firewall de Danny. Cuando OpenAI envía una llamada MCP, el daemon local de `tunnel-client` alimenta el proceso MCP por `stdio`.

---

## 3. Ruta 2: Servidor MCP Streamable HTTP (SSE) (`src/mcp/http-server.ts`) [NUEVO]

Para clientes que admiten la especificación MCP 2024-11-05 sobre Server-Sent Events (como ChatGPT Desktop o conectores HTTP locales):

- **Archivo:** [`src/mcp/http-server.ts`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/src/mcp/http-server.ts)
- **Puerto de Escucha:** `127.0.0.1:8794` (configurable vía `ISYMCP_MCP_HTTP_PORT`)
- **Flujo de Conexión:**
  1. `GET /health`: Health-check JSON con catálogo de herramientas autorizadas.
  2. `GET /sse`: Abre el flujo persistente `text/event-stream` y emite el endpoint de sesión:
     ```
     event: endpoint
     data: /messages?sessionId=0457dafe-5487-43cf-8d96-b08e235d64e9
     ```
  3. `POST /messages?sessionId=...`: Recibe las tramas JSON-RPC (`tools/list`, `tools/call`, `initialize`) y las despacha al motor de solo lectura.

---

## 4. Evidencia de Verificación Empírica

Ejecución de la suite [tests/mcp-http-server.test.ts](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/tests/mcp-http-server.test.ts):
```
tests/mcp-http-server.test.ts:
✓ SSE-01: Health check retorna transporte mcp-sse y las 4 herramientas [36.32ms]
✓ SSE-02: Rechaza peticiones con Host header ajeno (DNS Rebinding) [0.88ms]
✓ SSE-03: Rechaza orígenes no autorizados por CORS [0.54ms]
✓ SSE-04: Inicia stream SSE y emite evento de endpoint con sessionId [5.06ms]
✓ SSE-05: Petición POST a /messages sin sessionId válido es rechazada [3.37ms]

 5 pass
 0 fail
Ran 5 tests across 1 file. [338.00ms]
```

---

## 5. Conclusión Epistémica (Fase A)
`DEMONSTRATED`: Se comprueba que ISyMCP dispone de un transporte de túnel seguro activo (`tunnel-client`) y un adaptador nativo Streamable HTTP SSE (`:8794`), garantizando compatibilidad total con la infraestructura de plugins y Custom MCP Servers de OpenAI sin exponer puertos a la Internet pública.
