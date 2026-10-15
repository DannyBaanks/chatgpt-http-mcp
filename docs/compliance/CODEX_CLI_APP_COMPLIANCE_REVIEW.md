# Auditoría Especial de Cumplimiento: Codex CLI y Codex Desktop App

**Documento:** `docs/compliance/CODEX_CLI_APP_COMPLIANCE_REVIEW.md`  
**Proyecto:** ISyMCP / chatgpt-http-mcp-impl  
**Fecha:** 2026-10-14  
**Prioridad:** P0 — Account Safety  
**Objeto:** Evaluación de los mecanismos de integración con las herramientas oficiales Codex de OpenAI.

## Estado operativo actualizado — 2026-10-15

`src/codex-app.ts` ahora falla de forma segura antes de leer credenciales o
crear un perfil, e `isymcp conversation new --client app` se rechaza antes de
iniciar el bridge o escribir configuración. Los intents y recibos nuevos solo
aceptan el cliente Codex CLI soportado. Los resultados de generación de perfiles
que aparecen abajo son evidencia histórica de viabilidad técnica, no de soporte
actual ni de autorización. No hay registrado un contrato oficial de autenticación
multi-perfil, por lo que sigue vigente la decisión P0 `UNKNOWN / NO EXECUTE`.

---

## 1. Distinción Fundamental de Niveles de Integración

Para evaluar el cumplimiento estricto, es obligatorio categorizar cada interacción en uno de los cuatro niveles siguientes:

```
[Nivel 1] Integración Documentada Oficial
   ↓
[Nivel 2] Extensión / Proveedor Personalizado Soportado
   ↓
[Nivel 3] Reutilización / Compartición de Sesión Autenticada
   ↓
[Nivel 4] Uso Programático de Interfaz Privada / Sintética
```

Una prueba técnica exitosa en Nivel 3 o 4 demuestra **viabilidad funcional**, pero **NO constituye evidencia de cumplimiento contractual ni autorización de la plataforma**.

---

## 2. Evaluación de Codex CLI

### A. Proveedor Personalizado (`model_providers.<name>`)
* **Nivel:** **Nivel 2 (Soportado)**.
* **Mecanismo:** El archivo de configuración oficial de Codex (`~/.codex/config.toml`) permite definir proveedores compatibles con el protocolo de OpenAI / Responses mediante:
  ```toml
  model_provider = "isymcp_web"
  [model_providers.isymcp_web]
  name = "ISyMCP Web"
  base_url = "http://127.0.0.1:8791/v1"
  wire_api = "responses"
  ```
* **Evaluación de Cumplimiento:** **ALLOW**.
  * Codex CLI está diseñado para interactuar con servidores locales de desarrollo y proxies compatibles.
  * No vulnera ninguna regla de autenticación siempre que el servidor en `127.0.0.1:8791` cumpla con las políticas de origen y destino.
  * La bandera `--no-daemon` y el paso de variables de entorno como `ISYMCP_LAUNCH_ID` son mecanismos estándar del sistema operativo.

### B. Herramientas Locales y Sandboxing (`codex_exec` / `bwrap`)
* **Nivel:** **Nivel 1 / 2**.
* **Mecanismo:** Codex delega la ejecución de herramientas a comandos locales en el sistema del usuario con políticas de sandbox (`readOnly` con `bubblewrap` o similar).
* **Evaluación de Cumplimiento:** **ALLOW**.
  * El usuario tiene soberanía total sobre qué procesos se ejecutan en su máquina.
  * El confinamiento estricto de secretos y la denegación de acceso a claves de red o tokens garantiza que las herramientas no filtren credenciales.

---

## 3. Evaluación de Codex Desktop App

### A. Clonación de Perfiles (`src/codex-app.ts`)
* **Nivel:** **Nivel 4 (Interfaz Privada / No Documentada)**.
* **Mecanismo:**
  1. `prepareCodexApp` toma el archivo oficial `~/.codex/auth.json` del usuario y lo copia a `~/.isymcp-app/<launchId>/codex/auth.json`.
  2. Crea un directorio sintético de Electron `--user-data-dir=~/.isymcp-app/<launchId>/electron`.
  3. Ejecuta el binario `/usr/lib/chatgpt/ChatGPT` con variables `CODEX_HOME` y `CODEX_ELECTRON_USER_DATA_PATH` redirigidas.
* **Riesgos Contractuales y de Seguridad:**
  1. *Token Replay / Multi-Session:* La duplicación de `auth.json` entre múltiples instancias en ejecución puede ser detectada por el backend de autenticación de OpenAI como anomalía de sesión, provocando la invalidación forzada de todos los tokens de la cuenta.
  2. *Inexistencia de API pública:* Electron de ChatGPT Desktop no expone formalmente una interfaz de línea de comandos para automatización de perfiles de terceros.
* **Evaluación de Cumplimiento:** **UNKNOWN** ⇒ **NO EXECUTE**.
  * Por mandato de la política de seguridad P0, cualquier capacidad clasificada como `UNKNOWN` debe permanecer deshabilitada para salvaguardar la cuenta.

---

## 4. Matriz Comparativa Codex CLI vs. Codex App

| Superficie | Nivel | Documentación Oficial | Riesgo para la Cuenta | Veredicto P0 |
|---|---|---|---|---|
| **Codex CLI (`isymcp conversation new --client cli`)** | Nivel 2 | Sí (OpenAI Codex CLI docs) | Bajo (característica estándar local) | **ALLOW** |
| **Codex CLI Sandbox Local (`bwrap-read-only`)** | Nivel 1 | Sí (Arquitectura Codex) | Nulo (control 100% local del host) | **ALLOW** |
| **Codex App Clone (`isymcp conversation new --client app`)** | Nivel 4 | No (comportamiento no documentado) | Alto (riesgo de baneo/revocación de token) | **UNKNOWN / NO EXECUTE** |

---

## 5. Recomendación Técnica
1. **Consolidar el uso exclusivo de Codex CLI** para todas las integraciones de agentes locales.
2. Suspender el lanzador sintético de Codex Desktop App hasta que OpenAI publique soporte oficial para perfiles de terceros o autenticación multi-workspace.
