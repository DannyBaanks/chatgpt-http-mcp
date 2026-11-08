# CC-08-OPENAI-APPS-SDK.md — Integración Nativa con OpenAI Apps SDK (ASDK) y Vistas MCP-UI

**Misión:** CC-08: Integración Oficial de Páginas Conectadas de ChatGPT (`chatgpt.com/mcp-app/asdk_app_*`)  
**Fecha:** 2026-11-07  
**Operador / Arquitecto:** Danny Baanks / AGY (Antigravity)  
**Revisión Técnica:** GPT-6 (Aprobado con distinción de entrypoints y bridge JSON-RPC)  
**Rama:** `feat/isymcp-control-center-ui`  
**Recurso MCP Oficial:** `ui://isymcp/control-center` (`text/html;profile=mcp-app`)  
**Alias MCP-UI:** `ui://widgets/control-center` (`text/html`)  

---

## 1. El Misterio Resuelto: De Plugins Antiguos a OpenAI Apps SDK

Danny identificó en la barra lateral de ChatGPT las URLs exactas de las pestañas activas de aplicaciones:
* `https://chatgpt.com/mcp-app/asdk_app_69c18c28f1188191bf5b8445c4ab0a2e/notion-page-view` (Notion)
* `https://chatgpt.com/mcp-app/asdk_app_6943a2c078b0819188de39e4fe168d9b/open_tarot` (Open Tarot)

### Análisis de la Arquitectura `asdk_app_*`
1. **`asdk_app` = Apps SDK Application**: La plataforma de complementos de OpenAI en ChatGPT evolucionó desde los plugins de 2023 hacia **MCP Apps** sustentadas en el estándar abierto **Model Context Protocol (MCP)**.
2. **Páginas Conectadas (Connected Pages)**: ChatGPT conecta servidores MCP y proyecta interfaces interactivas en iframes protegidos montados bajo `/mcp-app/asdk_app_<hash>/<view_name>`.
3. **Mecanismo de Descubrimiento de Vistas y Sidebar Entrypoint**:
   - El servidor MCP expone un recurso URI con esquema `ui://` y tipo de contenido `text/html;profile=mcp-app`.
   - La herramienta lanzadora declara en `_meta` tanto el `ui.resourceUri` como los puntos de entrada oficiales para la navegación lateral y el panel de hilo:
     ```json
     "_meta": {
       "ui": {
         "resourceUri": "ui://isymcp/control-center"
       },
       "ui.resourceUri": "ui://isymcp/control-center",
       "openai/outputTemplate": "ui://isymcp/control-center",
       "openai/ui": {
         "entrypoints": [
           { "type": "global" },
           { "type": "thread" }
         ]
       },
       "ui.visibility": ["model", "app"]
     }
     ```
   - Al registrarse la herramienta, ChatGPT genera la vista conectada en la barra lateral global (`global`) y en el panel lateral de conversación (`thread`) para el usuario.

---

## 2. Implementación en ISyMCP

Se implementaron los componentes auditados y validados por GPT-6:

### A. Recurso UI Embebible Autosuficiente (`renderControlCenterEmbeddedHtml`)
En [`src/control-center/ui.ts`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/src/control-center/ui.ts):
- Genera un documento HTML completo, responsivo y sin ninguna dependencia externa de CDNs de internet.
- Incluye variables CSS nativas, temas oscuros, estilos de tarjetas, cuadrículas y botones del Control Center.
- Integra soporte dual para el protocolo de mensajes de OpenAI Apps SDK y MCP Apps estándar:
  - Protocolo estándar JSON-RPC sobre `postMessage`:
    - Responde al handshake `ui/initialize` devolviendo `protocolVersion: "2024-11-05"` y emitiendo `ui/notifications/initialized`.
    - Maneja `ui/notifications/host-context-changed` aplicando dinámicamente `data-theme`.
  - Fallbacks compatibles con eventos `openai:set-theme` y `openai:app-ready`.

### B. Declaración de Recursos en el Servidor MCP de Solo Lectura
En [`src/mcp/readonly.ts`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/src/mcp/readonly.ts):
1. `ui://isymcp/control-center`: Recurso canónico de la vista con MIME `text/html;profile=mcp-app`.
2. `ui://widgets/control-center`: Alias de compatibilidad estándar para entornos MCP-UI abiertos.
3. `isymcp://protocol/agents.md`: Documento markdown oficial de coordinación de agentes.

### C. Separación Limpia entre Consulta de Datos y Lanzador de UI
En [`src/mcp/gateway.ts`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/src/mcp/gateway.ts):
- Siguiendo la recomendación arquitectónica de GPT-6, las 4 herramientas de consulta (`isymcp_get_overview`, `isymcp_get_glossary`, `isymcp_get_tasks`, `isymcp_get_protocol`) retornan datos puros sin metadatos de UI para evitar recreaciones innecesarias del iframe.
- La herramienta lanzadora dedicada:
  ```ts
  isymcp_open_control_center({ tab?: "dashboard" | "cli" | "catalog" | "monitor" | "tui" | "github" | "media" | "comfy" | "fuzz" })
  ```
  declara los metadatos de UI completos (`openai/ui.entrypoints: [{type: "global"}, {type: "thread"}]`, `openai/outputTemplate`, `ui.initialTab`).

### D. Servidor Streamable HTTP (SSE)
En [`src/mcp/http-server.ts`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/src/mcp/http-server.ts):
- Expone las 5 herramientas y los 3 recursos autorizados.
- Mantiene la protección estricta en loopback, prevención de DNS Rebinding y cabeceras CORS para `chatgpt.com`.

---

## 3. Matriz de Pruebas y Evidencia

| Prueba | Componente | Resultado | Evidencia |
|---|---|---|---|
| `renderControlCenterEmbeddedHtml` | UI Autosuficiente | **DEMONSTRATED** | Genera HTML con handshake JSON-RPC `ui/initialize`, fallback `openai:app-ready`, CSS variables, cero scripts externos |
| `resources/list` | Servidor MCP | **DEMONSTRATED** | Expone `ui://isymcp/control-center`, `ui://widgets/control-center`, `isymcp://protocol/agents.md` |
| `resources/read` | Servidor MCP | **DEMONSTRATED** | Retorna contenido HTML con `mimeType: "text/html;profile=mcp-app"` mediante cliente MCP en memoria |
| `_meta` en `isymcp_open_control_center` | Gateway Tools | **DEMONSTRATED** | Devuelve `ui.resourceUri`, `openai/outputTemplate` y `openai/ui.entrypoints` (`global`, `thread`) |
| Separación de Datos y Renderizado | Gateway Tools | **DEMONSTRATED** | `isymcp_get_overview` no inyecta `ui.resourceUri` |
| Aislamiento de Autoridad | Seguridad Host | **DEMONSTRATED** | Todas las herramientas permanecen `readOnlyHint: true`; ninguna herramienta de mutación ni shell |
| Suite Automatizada | Bun Test | **DEMONSTRATED** | 2/2 PASS (39 assertions) en `tests/openai-apps-sdk.test.ts` |
| Integración HTTP SSE | Servidor Remoto | **DEMONSTRATED** | 5/5 PASS en `tests/mcp-http-server.test.ts` |
| Suite Completa del Proyecto | Bun Test | **DEMONSTRATED** | 63/63 PASS en 7 suites completas |

---

## 4. Resultado de Conexión en ChatGPT

Cuando Danny conecte el servidor MCP de ISyMCP a ChatGPT (en Ajustes > Apps Conectadas / Servidores MCP o mediante el modo desarrollador del Apps SDK):
1. ChatGPT identificará automáticamente las herramientas y los recursos de UI declarados con `profile=mcp-app`.
2. Gracias a `entrypoints: [{type: "global"}, {type: "thread"}]`, ChatGPT habilitará la entrada en la barra lateral de navegación y en el panel lateral de conversación.
3. ChatGPT asignará un identificador de aplicación `asdk_app_<hash>`.
4. ChatGPT montará la pestaña de **Páginas Conectadas**:
   ```
   https://chatgpt.com/mcp-app/asdk_app_<hash>/control-center
   ```
5. Al abrirla, renderizará directamente el panel interactivo de ISyMCP Control Center dentro de la propia interfaz web de ChatGPT y ejecutará el handshake `ui/initialize`.
