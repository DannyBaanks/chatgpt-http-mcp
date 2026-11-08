# CC-04 — Guía de Registro y Conexión Privada para el Operador (Fase C)

**Fecha:** 2026-11-07  
**Destinatario:** Danny Baanks (Operador Humano) & GPT-6 (Arquitecto)  
**Estado:** `DEMONSTRATED`  
**Referencia:** OpenAI Help Center (MCP & Custom GPT Actions)

---

## 1. Opciones de Vinculación en la Cuenta de ChatGPT

Para que ChatGPT pueda invocar en vivo las cuatro herramientas de ISyMCP sin conceder permisos de ejecución, Danny puede elegir cualquiera de las siguientes tres modalidades oficiales:

---

### Opción 1: ChatGPT Desktop / Developer Mode (Custom MCP Server) [RECOMENDADA]

Si Danny utiliza ChatGPT Desktop (o la opción de desarrollador en web si está habilitada en su plan):

1. **Levantar el listener SSE de loopback:**
   ```bash
   bun run src/mcp/http-server.ts
   ```
   *(El servidor escucha en `http://127.0.0.1:8794/sse` con las 4 herramientas de solo lectura).*
2. **En ChatGPT Desktop:**
   - Ir a **Configuración** (`Settings`) → **Advanced / Developer** → **MCP Servers**.
   - Hacer clic en **Add Server**.
   - **Nombre:** `ISyMCP Control Center`
   - **Tipo:** `SSE`
   - **URL:** `http://localhost:8794/sse`
3. **Alternativa Directa por Stdio (sin red):**
   ```json
   {
     "mcpServers": {
       "isymcp-control-center": {
         "command": "bun",
         "args": [
           "run",
           "/home/danny/Development/ISyCo Git/chatgpt-http-mcp/src/mcp/readonly.ts"
         ]
       }
     }
   }
   ```

---

### Opción 2: Custom GPT Privado vía OpenAPI 3.1 (ChatGPT Web)

Para interactuar directamente en `chatgpt.com` sin clientes locales de escritorio:

1. Abrir el editor de GPTs: [https://chatgpt.com/gpts/editor](https://chatgpt.com/gpts/editor).
2. En la pestaña **Configure**:
   - **Name:** `ISyMCP Control Center (Private)`
   - **Description:** `Acceso gráfico y de monitoreo de solo lectura para el monorepo y herramientas de Danny.`
   - **Instructions:**
     ```markdown
     Eres el asistente de control de ISyMCP. Utiliza exclusivamente las herramientas de inspección disponibles (overview, glossary, tasks, protocol) para consultar el estado del host. No intentes ejecutar comandos de shell ni mutaciones.
     ```
3. En la sección **Actions**:
   - Clic en **Create new action**.
   - En el cuadro **Schema**, pegar íntegro el contenido de [docs/chatgpt-readonly-plugin.json](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/docs/chatgpt-readonly-plugin.json).
4. **Visibilidad:** Seleccionar estrictamente **"Only me"**. Guardar.

---

### Opción 3: Secure MCP Tunnel Existente (`tunnel-client`)

Dado que el proceso `tunnel-client` (PID `968939`) ya se encuentra conectado con `https://api.openai.com` bajo el tunnel ID `tunnel_6acaaf6bbfb88191a9f8a2ecb291e46a`:

- Las herramientas de lectura (`isymcp_get_overview`, `isymcp_get_glossary`, `isymcp_get_tasks`, `isymcp_get_protocol`) están incorporadas en `src/mcp/main.ts`.
- Cualquier conversación vinculada a la integración corporativa/privada de Danny ya dispone de estas herramientas en su catálogo de herramientas conectado.

---

## 2. Medidas de Seguridad Garantizadas
- **Sin Credenciales en Formularios:** No requiere ingresar API Keys de Danny ni exponer tokens.
- **Sin Puertos Expuestos:** No se requiere abrir puertos en el router (`8798`, `8799` y `8794` permanecen atados exclusivamente a `127.0.0.1`).
- **Control Total del Operador:** Danny puede iniciar o detener los procesos en cualquier momento mediante `isymcp down` o cerrando la terminal.
