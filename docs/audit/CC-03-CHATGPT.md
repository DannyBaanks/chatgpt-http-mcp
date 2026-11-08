# CC-03 — Compatibilidad y Guía de Conexión Privada con ChatGPT (Fase C)

**Fecha:** 2026-11-07  
**Auditor:** Antigravity (AGY) para Danny Baanks & GPT-6  
**Estado:** `DEMONSTRATED`  
**Referencia:** `docs/chatgpt-readonly-plugin.json`, `src/mcp/readonly.ts`

---

## 1. Opciones Oficiales de Integración Soportadas

Existen dos vías oficiales proporcionadas por OpenAI para integrar herramientas externas en ChatGPT sin inyectar código en el frontend web:

```
┌────────────────────────────────────────────────────────┐
│             ChatGPT (chatgpt.com / Desktop)            │
└──────────────┬──────────────────────────┬──────────────┘
               │ (Modalidad A)            │ (Modalidad B)
               ▼                          ▼
     OpenAPI 3.1 Custom Action      MCP Stdio Connector
  (docs/chatgpt-readonly-plugin.json)  (src/mcp/readonly.ts)
               │                          │
               ▼                          ▼
      Loopback HTTP Proxy          Local Stdio Process
       (127.0.0.1:8798)             (Zero Network Port)
               │                          │
               └───────────┬──────────────┘
                           ▼
             ISyMCP Control Center Read-Only
             (overview, glossary, tasks, protocol)
```

---

## 2. Modalidad A: Custom Action Privada (OpenAPI 3.1)

Esta modalidad permite que ChatGPT Web invoque las herramientas de solo lectura directamente desde una conversación o Custom GPT.

### Especificación OpenAPI 3.1
El archivo [docs/chatgpt-readonly-plugin.json](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/docs/chatgpt-readonly-plugin.json) define exclusivamente los 4 endpoints de inspección:
- `GET /api/control-center/overview`
- `GET /api/control-center/glossary`
- `GET /api/control-center/tasks`
- `GET /api/control-center/protocol`

### Procedimiento de Alta para Danny (Intervención de Operador Requerida):
1. Abrir [ChatGPT GPT Editor](https://chatgpt.com/gpts/editor).
2. Crear un nuevo GPT llamado **"ISyMCP Control Center"**.
3. En la pestaña **Configure**:
   - **Instructions:** Pegar el contenido del protocolo de coordinación (`isymcp://protocol/agents.md`).
   - Ir a la sección **Actions** y hacer clic en **Create new action**.
   - En el campo **Schema**, importar el contenido de `docs/chatgpt-readonly-plugin.json`.
4. **Seguridad y Privacidad:** Configurar el GPT como **"Only me"** (Privado).

---

## 3. Modalidad B: Servidor MCP Nativo (ChatGPT Desktop / Developer Mode)

Esta modalidad es la más segura y robusta porque **no abre ningún puerto de red**; ChatGPT se comunica con el servidor MCP directamente mediante el bus de procesos del sistema operativo (`stdio`).

### Configuración del Conector
En el archivo de configuración de servidores MCP de ChatGPT Desktop (o Claude Desktop / Cursor):
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

### Propiedades de Seguridad de la Modalidad B:
- **Zero Network Exposure:** No requiere puertos abiertos, túneles HTTP ni reenvío DNS.
- **Aislamiento de Proceso:** El servidor `src/mcp/readonly.ts` corre bajo las restricciones de proceso local de Danny.
- **Eliminación de Superficie de Ataque:** Zero herramientas de ejecución registradas.

---

## 4. Estado de Plataforma (`BLOCKED_BY_PLATFORM`)

> [!IMPORTANT]
> **Aclaración sobre la interfaz de usuario en `chatgpt.com`:**  
> Ningún script local, proceso daemon o servidor MCP puede inyectar automáticamente una pestaña personalizada en el sidebar izquierdo de `chatgpt.com` sin contar con una extensión de navegador instalada en Chrome o sin que Danny cree el Custom GPT manualmente en su cuenta.  
> 
> Una vez que Danny añade el Custom GPT con la especificación de `docs/chatgpt-readonly-plugin.json`, ChatGPT lo posiciona automáticamente en la zona de aplicaciones y atajos del sidebar oficial.
