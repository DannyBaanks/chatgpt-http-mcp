# codex-web-http — Arquitectura

Estado: ruta Linux CURRENT y verificada operativamente; paridad Windows
NOT_DEMONSTRATED hasta la ejecución de CI y las comprobaciones locales.

## 1. Ruta CURRENT (Production)

```
caller (TUI / HTTP / MCP Client)
  → POST /v1/chat/completions            src/server.ts + src/chat-completions.ts
  → session affinity                     src/sessions.ts  (~/.codex-web-http/sessions/default.json → conversationUrl)
  → web adapter                          src/web-turn.ts   (playwright-core + Chrome/Edge del host,
                                                            storage-state.json, connector CODEX_WEB_HTTP_CONNECTOR)
  → submit + observación DOM             src/web-turn.ts   (busy-wait "Detener", readLastAssistant, extractResponse)
  → live thinking stream                 src/thinking-stream.ts (extracción en tiempo real de razonamiento UI)
  → tool calls nativos (opcional)        túnel (~/.codex-web-http/bin/tunnel-client)
      → MCP stdio                        src/mcp/main.ts   (session token → sandbox exec/apply_patch/view_image)
  → HTTP body / SSE Stream               src/chat-completions.ts + src/responses/stream.ts
  → telemetría y métricas                src/metrics.ts (/api/metrics, /metrics, /api/health)
```

Otras superficies: `/v1/responses` passthrough nativo (`src/passthrough.ts`) y websocket
(`src/ws-responses.ts`); consola operativa `src/isymcp.ts` (up/down/status/session/tunnel/logs/tui/harness/metrics/health/smoke).

---

## 2. Componentes y Claims de Arquitectura

- **Electron: NO participa** en la ruta. Cero dependencias en `package.json`
  (`deps: @modelcontextprotocol/sdk, playwright-core`). Las menciones históricas
  fueron archivadas.
  Claims verificados: *"Electron no se ejecuta"* (DEMONSTRATED operativamente) ≠
  *"Electron no es dependencia"* (DEMONSTRATED por package.json) ≠
  *"browser automation eliminada"* (FALSO: Playwright/Chromium SIGUEN siendo el web adapter).
- **Lanzador Desacoplado de Codex:** No muta `~/.codex/config.toml` globalmente. Se utiliza el perfil aislado
  `codex-isymcp` que inyecta `-c openai_base_url=http://127.0.0.1:8791/v1` de forma efímera.
- **Motor de Harnesses Multi-Agente:** Estrategias duales:
  - Estrategia CLI (`mcp add`) para Claude Code, Codex, Copilot, Hermes, OpenClaw, Pi, Gemini.
  - Estrategia JSON declarativa (`mcp.json` / `opencode.json`) para Cursor IDE y OpenCode TUI.
- **Pensamiento y Razonamiento:** Captura de interfaces UI visibles en el DOM; delimitado honestamente
  como resúmenes de interfaz y no como la totalidad de los tokens latentes de CoT.

---

## 3. Telemetría y Salud en Vivo

- **Endpoints:**
  - `/api/health`: Chequeo rápido de estado, uptime y conexión upstream.
  - `/api/metrics`: JSON estructurado con latencias (avg/min/max), conteo de turnos (éxito/fallo/reasoning), tokens estimados y memoria (RSS/Heap).
  - `/metrics`: Endpoint compatible con Prometheus / OpenMetrics.
- **Impacto en Rendimiento:** Registro en memoria con latencia <1ms por turno sin I/O bloqueante.

---

## 4. Context Compaction & Pruning

- **Chats (`src/chats.ts`):** `compactChat` poda mensajes acumulados manteniendo el mensaje de inicio y una ventana reciente configurable (por defecto 40 mensajes).
- **Archivos de contexto (`src/context-file.ts`):** `compactContextText` recorta el cuerpo intermedio en volcados masivos superiores a 500 líneas.

---

## 5. Session Tokens y Sandbox Confinado

- Registro `~/.codex-web-http/codex-sessions.json` (0600), CLI `isymcp session mint|list|revoke`.
- Sandbox: `bwrap` en Linux; Docker Desktop Linux es el backend Windows predeterminado; Codex CLI ofrece el backend nativo Windows opcional. RO falla cerrado si el backend seleccionado no está disponible.
- Escritura y red: la escritura se limita al workspace de la sesión; la red está deshabilitada por defecto en todos los backends.
- Evidencia Windows: ejecución Docker y nativa **NOT_DEMONSTRATED** en esta rama hasta que pasen CI y las comprobaciones en un host Windows.
- Evidencia: `~/.codex-web-http/mcp-trace.log` (0600; tool + fingerprint + sesión resuelta).

---

## 6. Verificación E2E y Canarios

- **Suite de humo unificada (`scripts/e2e-all.ts` / `isymcp smoke`):** Valida en una pasada la salud del servidor, telemetría, detección de harnesses, parámetros del launcher y local guard.
- **Canario diario:** Monitoreo periódico de integridad del DOM contra cambios en chatgpt.com.
