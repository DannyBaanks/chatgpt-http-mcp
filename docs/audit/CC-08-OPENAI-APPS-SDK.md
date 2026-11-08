# CC-08-OPENAI-APPS-SDK.md — Integración Nativa con OpenAI Apps SDK (ASDK) y Vistas MCP-UI

**Misión:** CC-08: Integración Oficial de Páginas Conectadas de ChatGPT (`chatgpt.com/mcp-app/asdk_app_*`)  
**Fecha:** 2026-11-07  
**Operador / Arquitecto:** Danny Baanks / AGY (Antigravity)  
**Rama:** `feat/isymcp-control-center-ui`  
**Recurso MCP Oficial:** `ui://isymcp/control-center` (`text/html`)  
**Alias MCP-UI:** `ui://widgets/control-center` (`text/html`)  

---

## 1. El Misterio Resuelto: De Plugins Antiguos a OpenAI Apps SDK

Danny identificó en la barra lateral de ChatGPT las URLs exactas de las pestañas activas de aplicaciones:
* `https://chatgpt.com/mcp-app/asdk_app_69c18c28f1188191bf5b8445c4ab0a2e/notion-page-view` (Notion)
* `https://chatgpt.com/mcp-app/asdk_app_6943a2c078b0819188de39e4fe168d9b/open_tarot` (Open Tarot)

### Análisis de la Arquitectura `asdk_app_*`
1. **`asdk_app` = Apps SDK Application**: La plataforma de complementos de OpenAI en ChatGPT evolucionó desde los plugins de 2023 hacia **MCP Apps** sustentadas en el estándar abierto **Model Context Protocol (MCP)**.
2. **Páginas Conectadas (Connected Pages)**: ChatGPT conecta servidores MCP y proyecta interfaces interactivas en iframes protegidos montados bajo `/mcp-app/asdk_app_<hash>/<view_name>`.
3. **Mecanismo de Descubrimiento de Vistas**:
   - El servidor MCP expone un recurso URI con esquema `ui://` y tipo de contenido `text/html`.
   - Las herramientas del servidor MCP devuelven o definen metadatos `_meta` apuntando a dicho recurso:
     ```json
     "_meta": {
       "ui.resourceUri": "ui://isymcp/control-center",
       "openai/outputTemplate": "ui://isymcp/control-center",
       "ui.visibility": ["model", "app"]
     }
     ```
   - Al registrarse o invocarse la herramienta, ChatGPT genera la vista conectada en la barra lateral para el usuario.

---

## 2. Implementación en ISyMCP

Se implementaron tres componentes esenciales en el servidor MCP y la UI:

### A. Recurso UI Embebible Autosuficiente (`renderControlCenterEmbeddedHtml`)
En [`src/control-center/ui.ts`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/src/control-center/ui.ts):
- Genera un documento HTML completo, responsivo y sin ninguna dependencia externa de CDNs de internet.
- Incluye variables CSS nativas, temas oscuros, estilos de tarjetas, cuadrículas y botones del Control Center.
- Integra soporte para el protocolo de mensajes de OpenAI Apps SDK:
  - Escucha eventos `openai:set-theme` para sincronizar automáticamente el tema oscuro/claro de ChatGPT.
  - Emite `openai:app-ready` al host contenedor tan pronto como el DOM está listo.

### B. Declaración de Recursos en el Servidor MCP de Solo Lectura
En [`src/mcp/readonly.ts`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/src/mcp/readonly.ts):
1. `ui://isymcp/control-center`: Recurso canónico de la vista del Control Center.
2. `ui://widgets/control-center`: Alias de compatibilidad estándar para entornos MCP-UI abiertos.
3. `isymcp://protocol/agents.md`: Documento markdown oficial de coordinación de agentes.

### C. Metadatos `_meta` y Herramienta de Lanzamiento de Vista
En [`src/mcp/gateway.ts`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/src/mcp/gateway.ts):
- Todas las herramientas de solo lectura (`isymcp_get_overview`, `isymcp_get_glossary`, `isymcp_get_tasks`, `isymcp_get_protocol`) retornan `_meta` con `ui.resourceUri` y `openai/outputTemplate`.
- Se registró una nueva herramienta dedicada:
  ```ts
  isymcp_open_control_center({ tab?: "dashboard" | "cli" | "catalog" | "monitor" | "tui" | "github" | "media" | "comfy" | "fuzz" })
  ```
  Permite a ChatGPT desplegar y enfocar interactivamente la vista conectada del Control Center en una pestaña específica a petición del usuario.

### D. Servidor Streamable HTTP (SSE)
En [`src/mcp/http-server.ts`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/src/mcp/http-server.ts):
- Expone las 5 herramientas y los 3 recursos autorizados.
- Mantiene la protección estricta en loopback, prevención de DNS Rebinding y cabeceras CORS para `chatgpt.com`.

---

## 3. Matriz de Pruebas y Evidencia

| Prueba | Componente | Resultado | Evidencia |
|---|---|---|---|
| `renderControlCenterEmbeddedHtml` | UI Autosuficiente | **DEMONSTRATED** | Genera HTML con `openai:app-ready`, CSS variables, cero scripts externos |
| `resources/list` | Servidor MCP | **DEMONSTRATED** | Expone `ui://isymcp/control-center`, `ui://widgets/control-center`, `isymcp://protocol/agents.md` |
| `resources/read` | Servidor MCP | **DEMONSTRATED** | Retorna contenido HTML con `mimeType: "text/html"` mediante cliente MCP en memoria |
| `_meta` en `tools/call` | Gateway Tools | **DEMONSTRATED** | `isymcp_open_control_center` y `isymcp_get_overview` devuelven `ui.resourceUri` y `openai/outputTemplate` |
| Aislamiento de Autoridad | Seguridad Host | **DEMONSTRATED** | Todas las herramientas permanecen `readOnlyHint: true`; ninguna herramienta de mutación ni shell |
| Suite Automatizada | Bun Test | **DEMONSTRATED** | 2/2 PASS (35 assertions) en `tests/openai-apps-sdk.test.ts` |
| Integración HTTP SSE | Servidor Remoto | **DEMONSTRATED** | 5/5 PASS en `tests/mcp-http-server.test.ts` |

---

## 4. Resultado de Conexión en ChatGPT

Cuando Danny conecte el servidor MCP de ISyMCP a ChatGPT (en Ajustes > Apps Conectadas / Servidores MCP o mediante el modo desarrollador del Apps SDK):
1. ChatGPT identificará automáticamente las herramientas y los recursos de UI declarados.
2. ChatGPT asignará un identificador de aplicación `asdk_app_<hash>`.
3. ChatGPT montará la pestaña de **Páginas Conectadas**:
   ```
   https://chatgpt.com/mcp-app/asdk_app_<hash>/control-center
   ```
4. Al abrirla, renderizará directamente el panel interactivo de ISyMCP Control Center dentro de la propia interfaz web de ChatGPT.
