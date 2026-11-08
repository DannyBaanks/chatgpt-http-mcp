# CC-05 — Atestación de Enlace Final y Preparación de Conexión en Vivo

**Fecha:** 2026-11-07  
**Auditor:** Antigravity (AGY) para GPT-6 & Danny Baanks  
**Estado:** `LOCAL_READY / CHATGPT_E2E_PENDING`  
**Referencia:** `/home/danny/.codex-web-http/bin/isymcp-readonly-mcp`, `src/mcp/readonly.ts`, `src/mcp/http-server.ts`

---

## 1. Comprobación del Túnel Activo (Comprobación 1)

Se auditó el estado del proceso del túnel en ejecución en el sistema de Danny:

- **Proceso del Túnel:** PID `968939` (`/home/danny/.codex-web-http/bin/tunnel-client run --profile isymcp-native-media`) alojado en la sesión tmux `tunnel-mcp__isymcp-native-media__d361ab7d`.
- **Destino del Launcher:** El perfil actual apunta a `/home/danny/.codex-web-http/bin/isymcp-mcp`.
- **Hallazgo Crítico:** El proceso MCP dentro de tmux fue arrancado a las 16:08:12 (previo a la implementación de CC-02/CC-03/CC-04). Por diseño de `tunnel-client`, el proceso MCP sobre `stdio` es persistente por sesión.
- **Remediación para Modo de Solo Lectura Estricto:** Se preparó el lanzador dedicado `/home/danny/.codex-web-http/bin/isymcp-readonly-mcp` (chmod 0700) que invoca exclusivamente `src/mcp/readonly.ts`. Al apuntar el túnel a este binario o pasar `--readonly`, se garantiza que OpenAI reciba exclusivamente las cuatro herramientas de inspección.

---

## 2. Verificación de Ciclo Completo MCP (Comprobación 2)

Se verificó el protocolo Model Context Protocol sobre ambos transportes compatibles:

| Etapa Protocolar | Transporte Stdio (`src/mcp/readonly.ts`) | Transporte Streamable HTTP SSE (`:8794`) | Estado |
|---|---|---|---|
| `initialize` | Responde con capacidades `tools`, `resources` e instrucciones oficiales | Handshake SSE + evento de endpoint con `sessionId` | ✅ **VERIFICADO** |
| `tools/list` | Retorna exactamente 4 herramientas | Retorna exactamente 4 herramientas | ✅ **VERIFICADO** |
| `isymcp_get_overview` | HTTP 200 / Datos vivos de servicios (:8791, :8799) y métricas RSS | HTTP 200 / Datos vivos | ✅ **VERIFICADO** |
| `isymcp_get_glossary` | Catálogo tipado de 7 familias | Catálogo tipado | ✅ **VERIFICADO** |
| `isymcp_get_tasks` | Lectura directa de SQLite WAL (`monitor.db`) con HMAC | Lectura SQLite WAL | ✅ **VERIFICADO** |
| `isymcp_get_protocol` | Documento Markdown `isymcp://protocol/agents.md` | Documento Markdown | ✅ **VERIFICADO** |

---

## 3. Atestación de Ausencia de Rutas Alternativas de Ejecución (Comprobación 3)

Se auditó minuciosamente el espacio de nombres del servidor de solo lectura:

1. **`shell_exec`:** Ausente de la tabla de herramientas. Control negativo ejecutado retorna `-32602: Tool shell_exec not found`.
2. **`spawn_agy_tui`:** Ausente de la tabla de herramientas. Control negativo retorna `-32602: Tool spawn_agy_tui not found`.
3. **`codex_exec` / `codex_apply_patch`:** Ausentes de la tabla de herramientas.
4. **`github_exec` / `github_dispatch`:** Ausentes de la tabla de herramientas.
5. **Gateway Universal `isymcp`:** Desacoplado del servidor de solo lectura. Ningún comando shell puede ser inyectado como subacción.

---

## 4. Instrucciones Exactas para Danny (Comprobación 4)

Para habilitar la visualización e invocación directa desde esta conversación de ChatGPT sin exponer credenciales:

### Modalidad Recomendada A: Conector Oficial en ChatGPT
1. Navegar en el navegador a: [https://chatgpt.com/#settings/Connectors](https://chatgpt.com/#settings/Connectors).
2. Localizar el conector vinculado al túnel existente (`isymcp-native-media` / `tunnel_6acaaf6bbfb88191a9f8a2ecb291e46a`).
3. Verificar que el estado indique **"Connected"** o sincronizar la lista de herramientas.

### Modalidad B: Servidor MCP Desktop / Plugins (Streamable HTTP)
1. Iniciar el demonio SSE en terminal de Danny:
   ```bash
   bun run src/mcp/http-server.ts
   ```
2. En ChatGPT Desktop o menú de plugins:
   - Añadir Custom MCP Server con la URL local:
     ```
     http://localhost:8794/sse
     ```

---

## 5. Protocolo de Prueba en Vivo (Comprobación 5 & Gate Final)

Una vez que Danny verifique el conector en su cuenta:
1. GPT-6 emitirá desde esta conversación las 4 consultas:
   - Invocación a `isymcp_get_overview`
   - Invocación a `isymcp_get_glossary`
   - Invocación a `isymcp_get_tasks`
   - Invocación a `isymcp_get_protocol`
2. GPT-6 emitirá una llamada de control negativo intentando invocar `shell_exec`.
3. Al recibir las respuestas auténticas del host local y confirmar el rechazo de la llamada de ejecución, el gate avanzará de:
   `LOCAL_READY / CHATGPT_E2E_PENDING`  
   a  
   `DEMONSTRATED (CLOSED)`
