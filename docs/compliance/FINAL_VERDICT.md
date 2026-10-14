# Dictamen Final de Cumplimiento (Compliance Final Verdict) — ISyMCP V1

**Documento:** `docs/compliance/FINAL_VERDICT.md`  
**Proyecto:** ISyMCP / chatgpt-http-mcp-impl  
**Fecha:** 2026-10-14  
**Prioridad:** P0 — Account Safety  
**Autoridad final:** Usuario / Propietario de la cuenta  
**Estado:** AUDITORÍA READ-ONLY COMPLETADA  

---

## 1. Principio Fundamental y Conclusión Ejecutiva

> **"ISyMCP existe para facilitar la colaboración entre agentes y herramientas, no para evadir las restricciones de OpenAI. La conservación de la cuenta del propietario tiene prioridad absoluta sobre cualquier funcionalidad."**

El proyecto **ha demostrado viabilidad funcional completa** en el laboratorio (incluyendo ejecución de herramientas locales, correlación nativa y round-trip bidireccional). Sin embargo, una prueba técnica exitosa **NO equivale a autorización contractual**.

La auditoría de cumplimiento concluye que:
1. Las capacidades de **automatización de la interfaz web (CDP sobre `chatgpt.com`)** y de **elusión de detección de bots** son **INCOMPATIBLES (`DENY`)** con los Términos de Uso de OpenAI y conllevan un riesgo crítico para la cuenta.
2. La integración oficial de **Custom MCP Apps** de OpenAI en ChatGPT es **LEGÍTIMA PERO CONDICIONADA (`CONDITIONAL`)** al flujo en el que el humano opera el chat y autoriza las herramientas.
3. El uso de **Codex CLI con proveedores locales (`isymcp_web`)** y sandbox local es una capacidad **PERMITIDA (`ALLOW`)** respaldada por la arquitectura oficial de Codex.
4. Cualquier intento de continuar turnos ante un bloqueo de seguridad de OpenAI está **TERMINANTEMENTE PROHIBIDO**.

---

## 2. Clasificación Estructurada de Capacidades

### A. Capacidades Demostradas Técnicamente (Laboratorio Funcional)
* [x] Apertura de Chrome con perfil aislado loopback y conexión CDP (`src/visible/browser-host.ts`).
* [x] Inyección de mención `@Codex ISyMCP` en compositor de ChatGPT Web (`src/visible/browser-driver.ts`).
* [x] Vinculación de origen y tokens de sesión de un solo uso con `bindNativeSource` (`src/mcp/active-native.ts`).
* [x] Ejecución de comandos en sandbox aislado con `bwrap-read-only` (`src/mcp/main.ts`).
* [x] Recepción de llamadas MCP desde ChatGPT a través de túnel local (`test-visible-two-way.ts`).
* [x] Extracción de respuestas del DOM convertidas a Markdown (`src/visible/browser-observer.ts`).
* [x] Lanzador y argumentos para Codex CLI con proveedor `isymcp_web` (`src/codex-conversation.ts`).

---

### B. Capacidades Permitidas con Evidencia Oficial (`ALLOW`)
1. **Configuración de Proveedor Personalizado en Codex CLI:**
   * *Base documental:* Documentación oficial de Codex CLI (`~/.codex/config.toml`, campos `model_provider`, `model_providers.<id>`).
   * *Alcance:* Permite a Codex CLI hablar con endpoints locales que emulan la Responses API.
2. **Ejecución Local Segura en Sandbox Host:**
   * *Base documental:* Modelo de soberanía de procesos locales del usuario.
   * *Alcance:* Confinamiento con Bubblewrap (`bwrap`), namespaces de Linux, denegación de red y bloqueo de lectura de `$HOME`.
3. **Hardening de Seguridad Local del Servidor:**
   * *Base documental:* RFC 6454 / Protección contra CSRF y DNS Rebinding.
   * *Alcance:* Verificación de encabezados Host, Origin loopback y tokens locales en `127.0.0.1:8791`.

---

### C. Capacidades Condicionadas (`CONDITIONAL`)
1. **Servidor MCP Local como Custom App en ChatGPT:**
   * *Base documental:* Guía oficial de Custom MCP Apps en ChatGPT (`help.openai.com/en/articles/12584461`).
   * *Condición obligatoria:* Solo puede operar como **receptor de llamadas de herramientas** (`tools/call`) iniciadas por el usuario humano dentro de su sesión interactiva de ChatGPT. Requiere confirmación humana y **detención inmediata (Halt)** ante cualquier bloqueo del clasificador de seguridad de OpenAI.
2. **Puente Responses `/v1/responses`:**
   * *Condición obligatoria:* Solo puede despachar solicitudes hacia backends con API oficial (`api.openai.com`) o herramientas locales autorizadas. **No puede enrutar hacia scraping web**.

---

### D. Capacidades No Verificadas (`UNKNOWN` ⇒ `NO EXECUTE`)
1. **Clonación de Perfiles de Codex Desktop App (`src/codex-app.ts`):**
   * *Motivo:* La aplicación Electron no documenta el uso de perfiles secundarios mediante copia de `auth.json`. Riesgo no evaluado de revocación de sesiones OAuth.
   * *Acción:* Deshabilitada por defecto.

---

### E. Capacidades Incompatibles / Prohibidas (`DENY` ⇒ `PROHIBITED`)
1. **Conducción Automatizada de la Interfaz Web (`sendVisibleWebTurn`):**
   * *Infracción:* Viola la Sección 2(c)(iii) de los Términos de Uso de OpenAI (prohibición de extracción programática y automatización de interfaces de consumidor).
2. **Evasión de Controles Anti-Bot (Turnstile / Navigator Stealth):**
   * *Infracción:* Viola la Sección 2(c)(viii) de los Términos de Uso (prohibición de bypass de medidas de seguridad).
3. **Reintentos Automáticos ante Bloqueos de Seguridad:**
   * *Infracción:* Intentar burlar las decisiones de los clasificadores de seguridad de OpenAI constituye comportamiento adversarial no permitido.

---

## 3. Riesgos Críticos para la Cuenta del Propietario

| Nivel de Riesgo | Vector de Riesgo | Consecuencia Potencial |
|---|---|---|
| **CRÍTICO** | Detección de CDP/Playwright en `chatgpt.com` | Baneo permanente de la cuenta OpenAI y pérdida de suscripciones activas. |
| **CRÍTICO** | Evasión de bloqueos de seguridad de herramientas | Marcado de la cuenta por abuso deliberado de la API/plataforma. |
| **ALTO** | Duplicación no controlada de `auth.json` en Electron | Invalidación forzada de tokens de sesión y desconexión de clientes. |

---

## 4. Acciones Recomendadas y Hoja de Ruta

1. **Desactivar el Enrutador Web Automatizado:**
   * Modificar la resolución de transporte en `src/responses/task-turn.ts` para que `sendVisibleWebTurn` **nunca se active de forma autónoma**.
   * Requerir que el navegador visible sea operado 100% por el humano, o que las llamadas de agentes se canalicen a través de la API oficial con API key.

2. **Implementar el Sentinel Fail-Closed de Bloqueos:**
   * Integrar la detección del mensaje de bloqueo de OpenAI en el gestor de herramientas MCP:
     Si el resultado contiene `"blocked by OpenAI"`, registrar la evidencia, emitir código de fallo irrevocable y **abortar cualquier reintento**.

3. **Restringir Codex App al Cliente CLI:**
   * Mantener el soporte de Codex CLI (`isymcp conversation new --client cli`), que es estándar y seguro.
   * Desactivar el lanzador sintético de Electron (`--client app`) hasta obtener clarificación oficial.

4. **Tramitar Consultas Oficiales:**
   * Enviar las preguntas documentadas en `docs/compliance/OPEN_QUESTIONS_FOR_OPENAI.md` a los canales oficiales de soporte de OpenAI.

---

## 5. Evidencia Faltante

* [ ] Autorización explícita y por escrito de OpenAI para invocar turnos en ChatGPT Web mediante herramientas de accesibilidad/CDP locales.
* [ ] Especificación pública del contrato de perfiles de usuario en Codex Desktop App (Electron).
* [ ] Documentación técnica detallada de los umbrales del clasificador de seguridad en Custom MCP Apps.

---

## 6. Declaración de Cumplimiento

> **ESTADO DE CUMPLIMIENTO:** **PARCIAL Y CONDICIONADO**.  
> Las herramientas locales y la extensibilidad de Codex CLI cumplen con los estándares de la plataforma. La automatización de la interfaz web de ChatGPT y los reintentos contra bloqueos de seguridad quedan formalmente **VETADOS** para salvaguardar la cuenta del propietario.
