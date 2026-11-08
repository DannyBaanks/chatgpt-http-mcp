# CC-01-PLUGIN.md — Manifiesto MCP de Solo Lectura para ChatGPT

**Misión:** CC-01: Control Center Security & Plugin Readiness  
**Fecha:** 2026-11-07  
**Enfoque:** Especificación de Mínimo Privilegio (Read-Only) para Integración Segura  
**Esquema JSON Asociado:** [`docs/chatgpt-readonly-plugin.json`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/docs/chatgpt-readonly-plugin.json)  

---

## 1. Principio de Mínimo Privilegio (Read-Only Gate)

En cumplimiento estricto con la directiva de **GPT-6 (Fase 3 de CC-01)**:
- **Exclusión Total de Ejecución:** La primera versión conectable con ChatGPT **NO expone ninguna herramienta de ejecución de comandos (`shell.exec`), mutación en repositorios (`github.dispatch`), ni lanzamiento de procesos (`tui.spawn`)**.
- **Superficie de Exposición Exclusivamente de Consulta:**
  1. `getOverview`: Estado de salud de los servicios locales (bridge :8791, monitor :8799, túnel).
  2. `getGlossary`: Catálogo y descripción de contratos tipados (para que el modelo entienda capacidades sin invocarlas).
  3. `getTasks`: Lectura de tareas recientes en SQLite WAL y verificación de recibos HMAC.
  4. `getProtocol`: Documento Markdown oficial de bootstrap de agentes (`isymcp://protocol/agents.md`).

---

## 2. Transporte y Autenticación Segura

### A. Canal Cifrado por Túnel Seguro (Secure MCP Tunnel)
- ISyMCP utiliza `tunnel-client` (Cloudflare Tunnel) o túnel reverso HTTPS autenticado.
- La máquina local escucha únicamente en `127.0.0.1`. El túnel reenvía solicitudes HTTPS hacia el puerto local correspondiente sin abrir puertos en el router ni exponer la IP pública de Danny.

### B. Autenticación por Cabecera (x-isymcp-token)
- Tipo de Autenticación: `API Key` / Custom Header.
- Nombre de Cabecera: `x-isymcp-token`.
- Validación en Backend: Verificada mediante `guardLocalRequest` con tiempo constante (`timingSafeEqual`) contra el token persistido en `~/.codex-web-http/token` (permisos 0600).
- Rechazo de Solicitudes No Autenticadas: Cualquier llamada desde el exterior sin el token válido devuelve inmediatamente HTTP 401 / 403.

---

## 3. Procedimiento de Alta para Danny (ChatGPT Custom Plugin / App)

Una vez aprobada esta auditoría por GPT-6:

1. **Verificar túnel activo:**
   ```bash
   isymcp tunnel status
   ```
2. **Copiar el esquema de solo lectura:**
   Utilizar el archivo [`docs/chatgpt-readonly-plugin.json`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/docs/chatgpt-readonly-plugin.json).
3. **Registrar en ChatGPT:**
   - Ir a [chatgpt.com/gpts/editor](https://chatgpt.com/gpts/editor) -> **Configure** -> **Actions** -> **Create new action**.
   - Pegar el JSON de `docs/chatgpt-readonly-plugin.json`.
   - Reemplazar la URL del servidor con la URL activa del túnel.
   - En **Authentication**, seleccionar `API Key`, cabecera `x-isymcp-token`, e ingresar el token local.
   - Guardar con visibilidad **"Only me" (Privado)**.

De este modo, ChatGPT puede consultar el estado de la máquina, verificar recibos de tareas y leer el glosario de herramientas con **cero riesgo de ejecución no autorizada en el host**.
