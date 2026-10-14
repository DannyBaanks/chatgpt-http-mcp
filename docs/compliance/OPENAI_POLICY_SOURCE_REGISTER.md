# Registro de Fuentes de Autoridad y Políticas de OpenAI

**Documento:** `docs/compliance/OPENAI_POLICY_SOURCE_REGISTER.md`  
**Proyecto:** ISyMCP / chatgpt-http-mcp-impl  
**Fecha de consulta:** 2026-10-14  
**Estado:** VIGENTE / AUDITORÍA P0  
**Principio rector:** La documentación técnica o la viabilidad funcional NO sustituyen los términos legales ni constituyen autorización contractual.

---

## 1. Fuentes Oficiales Consultadas

### Fuente 1: OpenAI Terms of Use (Términos de Uso para Consumidores / Servicios Generales)
* **URL:** `https://openai.com/policies/terms-of-use/`
* **Fecha de consulta:** 2026-10-14
* **Sección aplicable:** Sección 2(c) (*Restrictions*) y Sección 3 (*Content & Output*).
* **Capacidad evaluada:** Automatización de interfaz web (`chatgpt.com`), uso de scripts o agentes para interactuar con la interfaz de usuario, extracción de respuestas.
* **Restricciones documentadas:**
  1. *Programmatic Extraction:* Queda expresamente prohibido "automatically or programmatically extract data or Output from our Services, except as permitted through our APIs or as explicitly allowed in our Service Terms".
  2. *Bypass of Protections:* Queda prohibido "bypass any protective measures or safety filters we place on our Services".
  3. *Representation:* Queda prohibido "represent that Output was human-generated when it was not".
  4. *Reverse Engineering / Scraping:* Prohibición general de scraping, ingeniería inversa de llamadas web privadas o emulación de clientes sin autorización de API.
* **Condiciones por plan:** Aplica a cuentas Free, Plus y Pro de ChatGPT. El uso de la interfaz web está previsto para interacción humana directa mediante navegador estándar, no para invocación desatendida desde scripts externos.

---

### Fuente 2: OpenAI Business & Service Terms (Términos de Servicio para Desarrolladores y API)
* **URL:** `https://openai.com/policies/service-terms/`
* **Fecha de consulta:** 2026-10-14
* **Sección aplicable:** *API Access, Authentication, Rate Limits & Acceptable Use*.
* **Capacidad evaluada:** Llamadas programáticas a modelos de OpenAI mediante API keys o pasarelas autorizadas.
* **Restricciones documentadas:**
  1. Las integraciones programáticas y desatendidas deben canalizarse a través de la API oficial (`api.openai.com`) utilizando credenciales de API emitidas formalmente.
  2. Las credenciales de usuario (tokens de sesión web, cookies de navegador) no son equivalentes a API keys y su uso fuera del cliente autorizado de origen no está contemplado como mecanismo de API.
  3. Todo límite de tasa (*rate limit*) y filtro de seguridad (*safety system*) debe ser respetado; los bloqueos son resoluciones vinculantes de la plataforma.

---

### Fuente 3: Creating Custom MCP Apps in ChatGPT (OpenAI Help Center)
* **URL:** `https://help.openai.com/en/articles/12584461-creating-custom-mcp-apps-in-chatgpt`
* **Fecha de consulta:** 2026-10-14
* **Sección aplicable:** *Developer Mode, MCP Server Configuration, Tool Invocation, Safety & User Approval*.
* **Capacidad evaluada:** Registro de servidores MCP externos como conectores/apps en ChatGPT (`asdk_app_*`), recepción de llamadas de herramientas (`tools/call`) iniciadas por el modelo, ejecución de herramientas locales por autorización del usuario.
* **Restricciones documentadas:**
  1. *Dirección del flujo:* El flujo previsto y soportado es: **Usuario interactúa en ChatGPT → Modelo decide invocar MCP App → ChatGPT solicita confirmación/aprobación al usuario → Servidor MCP externo ejecuta y devuelve resultado**.
  2. *Aprobación del usuario:* Las aplicaciones MCP en modo desarrollador exigen consentimiento explícito del usuario para llamadas de herramientas externas.
  3. *Seguridad de llamadas de herramientas:* OpenAI somete las llamadas a herramientas a su sistema de clasificación de seguridad en tiempo de ejecución. Si OpenAI no puede determinar el estado de seguridad de una solicitud, la plataforma emite un bloqueo autoritativo (`This tool call was blocked by OpenAI because we couldn't determine the safety status of the request`).
  4. *Alcance de la autorización:* La autorización de una MCP App permite al servidor MCP responder a ChatGPT; **NO autoriza a un agente externo a enviar mensajes automáticamente al chat ni a sustituir la presencia humana en el compositor web**.

---

### Fuente 4: Documentación y Arquitectura de Codex CLI / Codex App
* **URL:** Repositorios y binarios locales oficiales de Codex (`@openai/codex`, `/usr/lib/chatgpt/ChatGPT`).
* **Fecha de consulta:** 2026-10-14
* **Sección aplicable:** *Custom Model Providers, Wire API ("responses"), Configuration (`config.toml`)*.
* **Capacidad evaluada:** Inyección de un proveedor local personalizado (`model_providers.<id>`) en Codex CLI y perfiles aislados en Codex Desktop App.
* **Restricciones documentadas:**
  1. *Codex CLI:* Permite de forma documentada configurar proveedores personalizados con `wire_api = "responses"` o `"chat"`, apuntando a un endpoint local (`http://127.0.0.1:<port>/v1`). Esto es una característica legítima de extensibilidad local del CLI.
  2. *Codex Desktop App:* No cuenta con una especificación pública documentada para perfiles múltiples mediante manipulación directa de `auth.json` en directorios `--user-data-dir` sintéticos. Reutilizar tokens de sesión de Electron en instancias paralelas acarrea incertidumbre regulatoria y riesgo de revocación de sesión.

---

## 2. Tabla Resumen de Autoridad Contractual

| Superficie / Canal | Tipo de Interfaz | ¿Permite Automatización Externa? | Clasificación Inicial | Condición Obligatoria |
|---|---|---|---|---|
| **chatgpt.com (Web UI)** | Front-end de consumidor | **NO** (prohibido por §2(c)(iii) ToU) | **DENY** | Requiere interacción humana manual directa. |
| **OpenAI Custom MCP Apps** | Protocolo MCP (SSE/HTTP) | **SÍ** (para responder llamadas) | **CONDITIONAL** | Invocación originada por el modelo dentro de ChatGPT; respetar confirmaciones humanas y bloqueos de seguridad. |
| **Codex CLI Custom Provider** | Configuración local (`config.toml`) | **SÍ** (hacia endpoints locales) | **ALLOW** | El backend receptor no debe realizar scraping ni bypass de servicios restringidos. |
| **Codex App Profile Clone** | Electron binario cerrado | **NO DOCUMENTADO** | **UNKNOWN** | Alto riesgo de invalidación de sesión por OpenAI. Fail-closed. |
| **OpenAI Official API** | `api.openai.com` con API key | **SÍ** (canal oficial programático) | **ALLOW** | Respetar rate limits, ToU y políticas de uso aceptable. |

---

## 3. Disposiciones de Interpretación

1. **La ausencia de un CAPTCHA o Cloudflare challenge NO equivale a permiso.**
2. **El consentimiento del usuario local NO anula los términos del proveedor de servicio.**
3. **Cualquier ambigüedad normativa se clasifica como `UNKNOWN` y, por principio de seguridad de la cuenta, produce `NO EXECUTE`.**
