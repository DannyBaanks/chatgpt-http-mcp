# Guía Oficial de Integración de ISyMCP como App Privada en ChatGPT

Este documento describe la arquitectura real de integración entre **ISyMCP** y **chatgpt.com**, detallando cómo registrar una **App Privada oficial** sin alterar ni inyectar código en el frontend de OpenAI y respetando las limitaciones técnicas de la plataforma.

---

## 1. Realidad Técnica y Arquitectura de la Plataforma

### A. Límites de la Plataforma Web de ChatGPT (`chatgpt.com`)
1. **La barra lateral (sidebar) y zona de complementos** de `chatgpt.com` son componentes renderizados en el navegador por los servidores cloud de OpenAI a partir del estado de la cuenta del usuario.
2. Un proceso o servidor que corre en la máquina local (`127.0.0.1`) **NO PUEDE** mutar el sidebar de `chatgpt.com` por sí mismo sin que el usuario configure y guarde una App/Custom GPT en su perfil de OpenAI.
3. Inyectar pestañas en el DOM de `chatgpt.com` mediante extensiones de navegador no oficiales viola la integridad de la sesión y está expresamente desaconsejado.
4. **Estado: `BLOCKED_BY_PLATFORM` para inyección local directa sin registro en cuenta.**  
   Para que una aplicación aparezca en la barra de herramientas, selector del composer o barra lateral de ChatGPT, debe darse de alta mediante los canales oficiales provistos por OpenAI (Custom GPTs o Conectores MCP en ajustes de desarrollador).

---

## 2. Los Dos Mecanismos Oficiales Soportados

ISyMCP ofrece soporte oficial y nativo para dos modalidades de integración:

### Modalidad 1: Conector MCP (Model Context Protocol) — Recomendada
* **Identidad en el Composer:** `@CODEX ISYMCP` o `Codex ISyMCP` (definida en `src/mcp/identity.ts`).
* **Transporte:** Servidor MCP stdio expuesto mediante túnel seguro HTTPS (`isymcp tunnel connect` o Cloudflare).
* **Herramientas Disponibles:**
  - 8 herramientas nativas de ejecución en sandbox (`codex_turn_start`, `codex_exec`, `codex_apply_patch`, etc.).
  - Herramientas multimedia locales (`media_list`, `media_info`, `media_lookup`, etc.).
  - Workflows locales de ComfyUI (`comfyui_status`, `comfyui_generate`).
  - **Universal Gateway (`isymcp`):** Acceso al glosario de comandos, estado del monitor, y protocolo de agentes.

### Modalidad 2: Custom GPT Privado con Custom Actions (OpenAPI 3.1)
* **Ubicación:** Creado desde el editor oficial de GPTs (`chatgpt.com/gpts/editor`).
* **Esquema:** `docs/chatgpt-openapi-schema.json`.
* **Privacidad:** Configurado como **"Only me"** (Privado). CERO publicación en el GPT Store público.
* **Flujo:** ChatGPT envía solicitudes HTTP firmadas con la cabecera `x-isymcp-token` al endpoint del túnel.

---

## 3. Paso a Paso para Registrar tu App Privada en ChatGPT

### Paso 1: Levantar Servicios Locales
En tu terminal:
```bash
# Levanta el bridge y el túnel en segundo plano
isymcp up

# Verifica que el monitor continuo y el panel estén activos
isymcp status
```

### Paso 2: Obtener la URL del Túnel
Obtén el subdominio HTTPS asignado por el cliente de túnel:
```bash
isymcp tunnel status
```
Ejemplo: `https://tu-subdominio-asignado.trycloudflare.com`.

### Paso 3: Crear el Custom GPT en OpenAI
1. Inicia sesión en [chatgpt.com](https://chatgpt.com).
2. Ve a **Explore GPTs** -> **Create** (o abre directamente [chatgpt.com/gpts/editor](https://chatgpt.com/gpts/editor)).
3. En la pestaña **Configure**:
   - **Name:** `ISyMCP Control Center`
   - **Description:** `Consola privada de control y puente MCP para herramientas locales en la máquina de Danny.`
   - **Instructions:**
     ```markdown
     Eres el asistente de control para ISyMCP.
     Utilizas las acciones de ISyMCP Control Center para consultar estado del monitor, tareas, recibos y ejecutar herramientas autorizadas en la máquina local.
     Sigue siempre el principio de menor privilegio. Antes de invocar acciones con efectos (como shell.exec), solicita confirmación expresa del operador.
     ```
4. En la sección **Actions** -> haz clic en **Create new action**:
   - Pega el contenido de `docs/chatgpt-openapi-schema.json`.
   - Ajusta la URL en `servers[0].url` con tu URL HTTPS del túnel obtenida en el Paso 2.
   - En **Authentication**: Selecciona `API Key`, tipo `Custom Header Name`, nombre de cabecera: `x-isymcp-token`, y pega tu token local del bridge (obtenido con `isymcp session mint` o desde `~/.codex-web-http/token`).
5. En la esquina superior derecha, haz clic en **Save** y selecciona **Only me** (Privado).

---

## 4. ISyMCP Control Center — Interfaz Local Desacoplada

Para una experiencia visual completa e interactiva con acceso a todos los comandos y métricas sin depender del navegador de ChatGPT, utiliza el panel desacoplado local:

```bash
# Abre la interfaz visual del Control Center
isymcp ui
# o bien
isymcp panel control-center
```
Disponible en: **`http://127.0.0.1:8798/control-center`** (o en la pestaña **Control Center** del panel principal).

### Pestañas Incluidas en el Control Center:
1. **📊 Dashboard:** Estado de salud en tiempo real de Bridge (`:8791`), Monitor (`:8799`), Túnel y MCP Broker, con métricas de RAM y leases.
2. **📖 Catálogo CLI:** Explorador dinámico de contratos tipados con formularios interactivos para todas las familias (`tui`, `github`, `monitor`, `media`, `comfyui`, `protocol`, `shell`, `fuzz`).
3. **🛰️ Monitor & Tareas:** Inspección visual de la cola persistida en SQLite WAL, estados (`SUCCEEDED`, `RUNNING`, `AWAITING_APPROVAL`), recibos criptográficos HMAC y botón de aprobación de tareas.
4. **🖥️ AGY TUI Spawn:** Lanzador gráfico de consolas interactivas Antigravity con selección de modo (`auto`, `plan`, `accept-edits`), terminal y advertencias de seguridad.
5. **🐙 GitHub Suite:** Consulta de perfil autenticado de DannyBaanks, cuota de rate-limit, repositorios y pull requests sin filtrar tokens al DOM.
6. **🎬 Multimedia:** Inventario de activos locales, análisis técnico y verificador de enlaces de YouTube.
7. **🎨 ComfyUI:** Diagnóstico del servicio local de generación y catálogo de workflows.
8. **⚡ Fuzz & Protocolo:** Visor del protocolo oficial de coordinación de agentes (`isymcp://protocol/agents.md`) y ejecutor de pruebas de robustez sintáctica.

---

## 5. Medidas de Seguridad y Mitigación de Riesgos
- **Bind en Loopback:** Todos los servicios locales escuchan estrictamente en `127.0.0.1`.
- **Zero Token Leakage:** Ningún token, secreto ni clave privada se renderiza en el DOM ni se escribe en logs de depuración.
- **Fail-Closed en Comandos Peligrosos:** Acciones como `shell.exec`, `github.dispatch` o `tui.spawn` en modo `accept-edits` devuelven HTTP 403 `requires_confirmation: true` salvo que el operador marque la casilla de confirmación explícita.
