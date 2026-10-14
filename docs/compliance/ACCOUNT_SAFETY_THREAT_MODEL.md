# Modelo de Amenazas para la Seguridad de la Cuenta (Account Safety Threat Model)

**Documento:** `docs/compliance/ACCOUNT_SAFETY_THREAT_MODEL.md`  
**Proyecto:** ISyMCP / chatgpt-http-mcp-impl  
**Fecha:** 2026-10-14  
**Prioridad:** P0 — Account Safety  
**Principio rector:** La conservación de la cuenta de OpenAI del propietario tiene prioridad absoluta sobre cualquier funcionalidad de ISyMCP. Fail-Closed ante cualquier anomalía.

---

## 1. Vectores de Amenaza Identificados

### Vector T1: Detección de Automatización y Anti-Bot (Scraping / CDP Driving)
* **Descripción:** Control de un navegador web mediante Playwright / CDP sobre `chatgpt.com`.
* **Mecanismos de detección del proveedor:**
  * Huellas de CDP / Webdriver en llamadas JavaScript en segundo plano.
  * Análisis de eventos de puntero (ausencia de trayectorias físicas de ratón, clicks instantáneos sin movimiento previo).
  * Cadencia y regularidad temporal en la entrada de texto (`pressSequentially`).
  * Telemetría de Cloudflare Turnstile / reCAPTCHA Enterprise.
* **Impacto potencial:**
  * Bloqueo temporal por Cloudflare (HTTP 403 / Challenge Loop).
  * Marcado de cuenta para revisión humana.
  * Terminación inmediata de la suscripción ChatGPT (Plus / Pro) y baneo permanente de la cuenta de correo asociada.
* **Control de Mitigación Requerido:** **ELIMINACIÓN TOTAL DEL VECTOR**. Prohibir la conducción automatizada de la UI web. El navegador visible debe ser operado exclusivamente a mano por el humano.

---

### Vector T2: Inyección de Prompts No Confiables desde Agentes Externos
* **Descripción:** Un subagente o proceso externo envía instrucciones a través del bridge que intentan arrogarse permisos superiores, desactivar confirmaciones o solicitar herramientas fuera del alcance.
* **Impacto potencial:**
  * Ejecución de comandos no autorizados en el host.
  * Falso reporte de autorización hacia el modelo.
* **Control de Mitigación Requerido:**
  * Tratar todo prompt externo como **entrada no confiable**.
  * Ninguna instrucción de texto dentro de un prompt puede conceder permisos al modelo.
  * La autorización depende exclusivamente del token criptográfico de sesión (`turn_token`), la política del sandbox y la aprobación explícita del humano.

---

### Vector T3: Replay y Fuga de Tokens de Sesión (`turn_token` / `auth.json`)
* **Descripción:** Exposición de tokens de sesión en archivos de log públicos, volcados de depuración o tráfico no cifrado.
* **Impacto potencial:**
  * Secuestro de sesión por procesos no autorizados en el host.
  * Inconsistencias de tokens detectadas por OpenAI.
* **Control de Mitigación Implementado & Verificado:**
  * Sanitización automática (`src/sanitize.ts`): Redacción estricta de `turn_token: <redacted>` y eliminación de IDs de conversación en logs.
  * Tokens efímeros de un solo uso con caducidad en minutos (`ttlMinutes`).
  * Destrucción inmediata del token tras la finalización del turno (`revokeSession`).
  * Permisos de archivo estrictos `0600` (solo lectura/escritura para el UID del propietario) en directorios privados `0700`.

---

### Vector T4: Elusión de Bloqueos de Seguridad de OpenAI
* **Descripción:** Ante una respuesta de `BLOCKED` o `safety restriction` de OpenAI, intentar reintentar automáticamente cambiando el prompt, alternando conectores o fragmentando la petición para burlar el filtro.
* **Impacto potencial:**
  * Agravamiento de la severidad del bloqueo por parte de los sistemas de detección de abusos de OpenAI.
  * Baneo inmediato por comportamiento adversarial contra los filtros de seguridad.
* **Control de Mitigación Requerido:**
  * **FAIL CLOSED INMEDIATO**: Un bloqueo de OpenAI es una resolución definitiva y vinculante. Se prohíbe terminantemente cualquier reintento automático o técnica de evasión.

---

### Vector T5: Reutilización No Autorizada de Sesión de Codex Desktop App
* **Descripción:** Copia no supervisada de `auth.json` hacia perfiles sintéticos para ejecución en paralelo de instancias Electron.
* **Impacto potencial:**
  * Revocación masiva de credenciales OAuth de Codex.
* **Control de Mitigación Requerido:**
  * Clasificar como **UNKNOWN** y deshabilitar el lanzador sintético de la App (`codex-app.ts`) hasta que OpenAI defina un contrato multi-perfil soportado.

---

## 2. Matriz de Severidad y Políticas Fail-Closed

| Vector de Amenaza | Probabilidad | Impacto en la Cuenta | Nivel de Riesgo | Política de Respuesta |
|---|---|---|---|---|
| **T1: Scraping / CDP Web** | Alta | Fatal (Baneo de cuenta) | **CRÍTICO** | **DENY / STOP**: Desactivar automatización de UI |
| **T2: Prompt Injection / Privilege Escalation** | Media | Alto (Riesgo local) | **ALTO** | **FAIL CLOSED**: Entrada tratada como no confiable |
| **T3: Fuga de Tokens en Logs** | Baja | Alto (Compromiso de sesión) | **MEDIO** | **MITIGADO**: Sanitizado regex activo + chmod 0600 |
| **T4: Bypass de Filtros de Seguridad** | Alta | Fatal (Baneo permanente) | **CRÍTICO** | **DENY**: Prohibición absoluta de reintentos |
| **T5: Clonación de `auth.json` en App** | Media | Alto (Revocación de token) | **ALTO** | **UNKNOWN / NO EXECUTE**: Usar solo Codex CLI oficial |

---

## 3. Principio de Autenticación Universal Denegada
> **"Una sesión autenticada NO es una autorización universal."**
Estar autenticado ante un servicio solo otorga los derechos previstos para la interfaz correspondiente. Una sesión web interactiva no confiere derecho a inyectar tráfico automatizado desatendido.
