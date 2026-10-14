# Matriz de Clasificación de Capacidades — ISyMCP

**Documento:** `docs/compliance/ISYMCP_CAPABILITY_MATRIX.md`  
**Proyecto:** ISyMCP / chatgpt-http-mcp-impl  
**Fecha:** 2026-10-14  
**Prioridad:** P0 — Account Safety  
**Criterio vinculante:**
* `ALLOW`: Vía oficial documentada, respetando términos y límites.
* `CONDITIONAL`: Vía oficial que requiere condiciones estrictas (autorización explícita, sin automatización no permitida).
* `UNKNOWN`: Sin certeza documental suficiente ⇒ **NO EXECUTE**.
* `DENY`: Contradice términos, evade restricciones o usa interfaces privadas no autorizadas ⇒ **NO EXECUTE**.

---

## 1. Tabla Resumen de Capacidades

| Capacidad / Superficie | Ubicación en Código | Servicio OpenAI Involucrado | Interfaz Oficial | Clasificación | Acción Obligatoria |
|---|---|---|---|---|---|
| **Automated Web Driving** (`sendVisibleWebTurn`) | `src/visible/browser-turn.ts` | ChatGPT Web (`chatgpt.com`) | NO (CDP/Playwright sobre UI) | **DENY** | **DESHABILITAR** para flujos desatendidos |
| **Visible Session Probe** (`findActiveVisibleSession`) | `src/visible/browser-turn.ts` | Ninguno (inspección de socket local) | SÍ (IPC local) | **CONDITIONAL** | Permitido solo como telemetría local de estado |
| **Responses Adapter Task Loop** (`runTaskTurn`) | `src/responses/task-turn.ts` | Puente entre Codex y Web | Híbrido | **CONDITIONAL** | Permitido con backend API; **DENY** con backend scraping web |
| **Idle Timeout Adjustment** (`idleTimeout: 0`) | `src/server.ts` | Servidor HTTP local | SÍ (Bun runtime) | **ALLOW** | Mantenido para evitar caídas de sockets locales |
| **Turn Start Token Handshake** (`codex_turn_start`) | `src/mcp/main.ts` | Servidor MCP local | SÍ (MCP Tool) | **CONDITIONAL** | Permitido si la llamada proviene de ChatGPT con consentimiento |
| **Tool Inventory Exposure** (`codex_tool_inventory`) | `src/mcp/main.ts` | Servidor MCP local | SÍ (MCP Tool) | **CONDITIONAL** | Lista solo herramientas autorizadas en el sandbox |
| **Sandboxed Execution** (`codex_exec`) | `src/mcp/main.ts` | Servidor MCP local + bwrap | SÍ (MCP Tool local) | **CONDITIONAL** | Ejecución en sandbox local; **STOP** inmediato ante bloqueo OpenAI |
| **Turn Finalizer** (`codex_turn_complete`) | `src/mcp/main.ts` | Servidor MCP local | SÍ (MCP Tool) | **CONDITIONAL** | Cierre ordenado de turno MCP |
| **Native Source Binding** (`bindNativeSource`) | `src/mcp/active-native.ts` | Correlación local | SÍ (Local state) | **CONDITIONAL** | Solo para vincular turnos legítimamente autorizados |
| **Custom Provider Injection** (`isymcp_web`) | `src/codex-conversation.ts` | Codex CLI local | SÍ (Codex config TOML) | **ALLOW** | Soportado oficialmente por Codex CLI |
| **Codex CLI Launcher** (`conversation new --client cli`) | `src/isymcp.ts` | Codex CLI local | SÍ (CLI flags documentadas) | **ALLOW** | Soportado oficialmente por Codex CLI |
| **Codex App Profile Clone** (`conversation new --client app`) | `src/codex-app.ts` | Electron ChatGPT Desktop | NO (manipulación no documentada de perfiles) | **UNKNOWN** | **NO EXECUTE** hasta aclaración de términos |

---

## 2. Auditoría Detallada por Superficie

### 1. `src/visible/browser-turn.ts` — `sendVisibleWebTurn`
* **A. Qué hace realmente:** Simula la escritura de `@Codex ISyMCP`, clica en el conector, inyecta el prompt mediante pulsaciones de teclas sintéticas, pulsa el botón "Enviar" y sondea el DOM periódicamente mediante `read_bound_answer` hasta detectar `complete: true`.
* **B. Qué servicio de OpenAI utiliza:** Front-end web de `chatgpt.com`.
* **C. Qué credenciales utiliza:** Cookies de sesión y almacenamiento local del perfil de Chrome montado en `~/.codex-web-http/visible/<launchId>/chrome`.
* **D. Quién origina la solicitud:** Un script o agente local que llama al socket `browser.sock`.
* **E. Quién autoriza la operación:** El operador local al ejecutar el comando, pero **NO** cuenta con autorización de OpenAI para automatizar la interfaz web.
* **F. Qué datos lee o transmite:** Transmite prompts del usuario al chat web y lee el contenido generado en el DOM.
* **G. Qué efectos secundarios puede producir:** Detección por sistemas anti-bot (Cloudflare Turnstile, OpenAI bot detection), bloqueo temporal o permanente de la cuenta de usuario por violación de términos de uso.
* **H. Interfaz oficial:** **NO**. Es automatización de UI de consumidor sobre navegador controlado por CDP.
* **I. Restricciones aplicables:** Prohibición explícita de extracción programática y automatización de interfaz de consumidor (§2(c)(iii) ToU).
* **J. Clasificación:** **DENY**.

---

### 2. `src/responses/task-turn.ts` — `runTaskTurn`
* **A. Qué hace realmente:** Orquesta turnos de conversación de la API `/v1/responses`, gestionando bloqueos, leases de tareas locales, persistencia durable de turnos y selección de modelo/esfuerzo de razonamiento.
* **B. Qué servicio de OpenAI utiliza:** Puede comunicarse con `chatgpt.com` (a través de `sendVisibleWebTurn`) o con la API upstream.
* **C. Qué credenciales utiliza:** Si usa `sendVisibleWebTurn`, cookies del navegador; si usa forward nativo, tokens de autenticación de Codex.
* **D. Quién origina la solicitud:** Codex CLI o Codex Desktop App enviando POST a `/v1/responses`.
* **E. Quién autoriza la operación:** El usuario local en Codex.
* **F. Qué datos lee o transmite:** Entrada de tareas (`input`), historial de conversación y declaraciones de herramientas nativas.
* **G. Qué efectos secundarios puede producir:** Consumo de turnos, ejecución de herramientas locales si el modelo lo solicita.
* **H. Interfaz oficial:** Parcialmente. El protocolo `/v1/responses` emula la Responses API de OpenAI, pero la implementación de envío hacia ChatGPT Web viola los términos.
* **I. Restricciones aplicables:** Si se enruta a través de scraping de `chatgpt.com`, aplica **DENY**. Si se enruta hacia un backend API autorizado o MCP oficial, aplica **ALLOW**.
* **J. Clasificación:** **CONDITIONAL** (Dependiente del backend de transporte configurado).

---

### 3. `src/server.ts` — `startServer` / `Bun.serve`
* **A. Qué hace realmente:** Servidor HTTP y WebSocket local en `127.0.0.1:8791` que implementa guardas de loopback, CSRF, DNS rebinding y despacho idempotente de `/v1/*`.
* **B. Qué servicio de OpenAI utiliza:** Ninguno directamente (es un daemon de loopback local).
* **C. Qué credenciales utiliza:** Token local opcional (`CODEX_WEB_HTTP_TOKEN`).
* **D. Quién origina la solicitud:** Clientes locales (Codex CLI, panel, scripts).
* **E. Quién autoriza la operación:** El usuario en su máquina host.
* **F. Qué datos lee o transmite:** JSON-RPC local y payloads de peticiones locales.
* **G. Qué efectos secundarios puede producir:** Ninguno sobre OpenAI.
* **H. Interfaz oficial:** SÍ (Servidor HTTP local estándar).
* **I. Restricciones aplicables:** No exponer externamente a interfaces no loopback sin autenticación estricta (ya verificado por suite de hardening).
* **J. Clasificación:** **ALLOW**.

---

### 4. `src/mcp/main.ts` — Herramientas MCP (`codex_turn_start`, `codex_tool_inventory`, `codex_exec`, `codex_turn_complete`)
* **A. Qué hace realmente:** Implementa un servidor MCP estándar de Model Context Protocol expuesto vía túnel a ChatGPT Developer Mode.
* **B. Qué servicio de OpenAI utiliza:** ChatGPT Custom MCP Apps (`asdk_app_*`).
* **C. Qué credenciales utiliza:** Identificador de app asignado en el registro de ChatGPT Developer Mode.
* **D. Quién origina la solicitud:** ChatGPT Web cuando el modelo decide invocar una herramienta.
* **E. Quién autoriza la operación:** El usuario humano en ChatGPT (al interactuar y confirmar permisos de MCP app).
* **F. Qué datos lee o transmite:** Parámetros de llamadas de herramientas (nombre de herramienta, comandos autorizados, tokens de sesión) y salida de stdout/stderr.
* **G. Qué efectos secundarios puede producir:** Ejecución de comandos en el entorno local (sandboxeados con `bwrap`).
* **H. Interfaz oficial:** **SÍ**. Cumple la especificación MCP y la integración oficial de OpenAI para MCP Apps.
* **I. Restricciones aplicables:** Sujeto al sistema de seguridad de OpenAI. **Si OpenAI bloquea la llamada con error de seguridad, el sistema DEBE detenerse de inmediato y no intentar eludir el filtro**.
* **J. Clasificación:** **CONDITIONAL** (Permitido siempre que la interacción sea iniciada por el humano en el chat, respetando las aprobaciones y bloqueos de OpenAI).

---

### 5. `src/mcp/active-native.ts` — `bindNativeSource` & `mintNativeSession`
* **A. Qué hace realmente:** Asocia un token de sesión nativo de un solo uso (`turn_token`) con un `messageId` específico de ChatGPT para garantizar que un turno no sea reutilizado por terceros.
* **B. Qué servicio de OpenAI utiliza:** Ninguno externamente; correlaciona identificadores recibidos de ChatGPT.
* **C. Qué credenciales utiliza:** Ninguna credencial de OpenAI; genera tokens criptográficos locales efímeros.
* **D. Quién origina la solicitud:** El orquestador local.
* **E. Quién autoriza la operación:** El propietario local de la sesión.
* **F. Qué datos lee o transmite:** Identificadores UUID y metadatos de sesión.
* **G. Qué efectos secundarios puede producir:** Ninguno sobre la cuenta.
* **H. Interfaz oficial:** SÍ (Seguridad interna local).
* **I. Restricciones aplicables:** El token debe ser de uso único y destruirse tras el turno.
* **J. Clasificación:** **ALLOW** (como mecanismo de seguridad y acotamiento de privilegios locales).

---

### 6. `src/codex-conversation.ts` & `src/isymcp.ts` — `conversation new --client cli`
* **A. Qué hace realmente:** Genera los argumentos de línea de comandos para invocar el binario oficial `codex` configurando un proveedor de modelos aislado (`isymcp_web`).
* **B. Qué servicio de OpenAI utiliza:** Codex CLI oficial instalado en el sistema.
* **C. Qué credenciales utiliza:** Las credenciales que el CLI utilice para su conexión local (en este caso sin auth hacia 127.0.0.1).
* **D. Quién origina la solicitud:** El usuario ejecutando `isymcp conversation new`.
* **E. Quién autoriza la operación:** El usuario local.
* **F. Qué datos lee o transmite:** Parámetros de configuración TOML del CLI.
* **G. Qué efectos secundarios puede producir:** Ejecución de sesiones interactivas de Codex CLI.
* **H. Interfaz oficial:** **SÍ**. Codex CLI soporta oficialmente proveedores personalizados mediante `-c model_providers.<name>={...}`.
* **I. Restricciones aplicables:** El proveedor local debe respetar los términos del backend de destino.
* **J. Clasificación:** **ALLOW**.

---

### 7. `src/codex-app.ts` — `conversation new --client app`
* **A. Qué hace realmente:** Copia `auth.json` del usuario a un directorio privado `~/.isymcp-app/<launchId>/codex`, crea una carpeta `--user-data-dir` sintética para Electron y lanza `/usr/lib/chatgpt/ChatGPT` con variables de entorno modificadas.
* **B. Qué servicio de OpenAI utiliza:** La aplicación de escritorio Electron oficial de ChatGPT / Codex.
* **C. Qué credenciales utiliza:** Copia directa del token de autenticación del usuario (`auth.json`).
* **D. Quién origina la solicitud:** El comando local `isymcp conversation new --client app`.
* **E. Quién autoriza la operación:** El usuario local, pero sin soporte oficial de OpenAI para perfilado múltiple por copia de archivos.
* **F. Qué datos lee o transmite:** Lee `auth.json` y escribe configuraciones en el perfil clonado.
* **G. Qué efectos secundarios puede producir:** Inconsistencias de tokens en el backend de OpenAI, posible invalidación de sesión o alerta de seguridad por token duplicado en múltiples UIDs de Electron.
* **H. Interfaz oficial:** **NO**. Es manipulación de la estructura interna del paquete Electron en Linux.
* **I. Restricciones aplicables:** Incertidumbre regulatoria sobre clonación de credenciales nativas.
* **J. Clasificación:** **UNKNOWN** ⇒ **NO EXECUTE** hasta que exista soporte documentado de perfiles en la app de escritorio.
