# Política y Protocolo para la Gestión de Bloqueos de OpenAI

**Documento:** `docs/compliance/OPENAI_BLOCK_HANDLING.md`  
**Proyecto:** ISyMCP / chatgpt-http-mcp-impl  
**Fecha:** 2026-10-14  
**Prioridad:** P0 — Account Safety  
**Principio rector:** Los bloqueos de seguridad y las restricciones de OpenAI son resoluciones autoritativas de la plataforma. La elusión de un bloqueo constituye una infracción crítica y está estrictamente prohibida.

---

## 1. Definición de Estados de Bloqueo de OpenAI

Cualquiera de las siguientes señales devueltas por ChatGPT, Codex o la API se considera una **Decisión Autoritativa de Bloqueo**:
1. `BLOCKED`: La plataforma rechazó la ejecución de la herramienta o turno.
2. `DENIED`: El usuario o la plataforma denegó el permiso de acceso.
3. `Safety restriction`: El clasificador de seguridad de contenido o de herramientas vetó la operación.
4. `Unknown safety status`: Error explícito observado en producción:
   > *"This tool call was blocked by OpenAI because we couldn't determine the safety status of the request."*
5. `Confirmation required`: Se requiere confirmación humana en el cliente oficial y no ha sido concedida.
6. `Permission required`: Faltan permisos de conector o de workspace.
7. `Rate limit`: Se superó el límite de uso o peticiones por unidad de tiempo.
8. `Access restriction`: Restricción geográfica, de red o de tipo de cuenta.

---

## 2. Acciones Estrictamente Prohibidas

Ante cualquiera de los estados de bloqueo anteriores, queda **TERMINANTEMENTE PROHIBIDO**:

| Acción Prohibida | Por qué está prohibida | Severidad |
|---|---|---|
| **Cambio de herramienta (*Tool Hopping*)** | Cambiar a otra herramienta para lograr la misma acción vetada (ej. si `codex_exec` es bloqueado, intentar llamar a otra función de lectura/escritura). | **CRÍTICA** |
| **Cambio de backend (*Backend Hopping*)** | Si ChatGPT Web bloquea la llamada, redirigirla automáticamente a otra cuenta o a un browser headless alternativo para evadir el filtro. | **CRÍTICA** |
| **Reformulación (*Prompt Evasion*)** | Reescribir el prompt o cambiar la semántica de la orden para ocultar la intención real y sortear los clasificadores de seguridad. | **CRÍTICA** |
| **Fragmentación (*Chunking Bypass*)** | Dividir un comando o payload bloqueado en sub-partes más pequeñas para burlar la detección de firmas de seguridad. | **CRÍTICA** |
| **Delegación evasiva (*Agent Proxying*)** | Encargar a otro subagente de la red la ejecución de una tarea que ya fue rechazada por OpenAI. | **CRÍTICA** |
| **Rotación de sesiones (*Session Hopping*)** | Intentar sortear el bloqueo cerrando la sesión y abriendo una nueva o rotando cookies/tokens. | **CRÍTICA** |

---

## 3. Acciones Obligatorias y Permitidas

Cuando se produce un bloqueo, ISyMCP debe aplicar el siguiente protocolo de forma determinista:

```
[Respuesta de Bloqueo de OpenAI]
               │
               ▼
[1. DETENCIÓN INMEDIATA (HALT)] ──> No reintentar, no conmutar herramientas.
               │
               ▼
[2. REGISTRO EXACTO (AUDIT)]    ──> Grabar mensaje literal, timestamp y SHA-256.
               │
               ▼
[3. EXPLICACIÓN AL HUMANO]      ──> Reportar al usuario el texto íntegro del bloqueo.
               │
               ▼
[4. ESTADO = DENIED]            ──> Marcar el turno/tarea como finalizado con fallo de política.
```

### Acciones Específicas Permitidas:
1. **Registrar el resultado:** Guardar el recibo exacto en los archivos de verificación con el texto emitido por OpenAI.
2. **Explicar el motivo:** Informar claramente al propietario si el bloqueo provino de falta de confirmación, límite de tasa o clasificador de seguridad.
3. **Solicitar autorización legítima:** Si el bloqueo fue por `Confirmation required`, pedir al usuario que pulse el botón de confirmación en la UI oficial.
4. **Consultar documentación oficial:** Revisar las políticas para determinar si la operación está dentro de las directrices de uso aceptable.
5. **Ofrecer alternativa oficial:** Si la operación no es viable en la interfaz actual (ej. automatización desatendida en web), proponer al usuario migrar la tarea a la API oficial (`api.openai.com`) con las claves correspondientes.

---

## 4. Tratamiento de Errores Ambiguos

Si el error no declara expresamente su causa (por ejemplo, desconexiones abruptas, reseteos de socket o códigos de estado opacos):
* El estado debe clasificarse estrictamente como **`UNKNOWN`**.
* **PROHIBIDO** especular o asumir que el error es inocuo para continuar reintentando.
* Por política de seguridad de cuenta, **`UNKNOWN = NO EXECUTE`**. El sistema debe detenerse (*Fail-Closed*) hasta que el operador humano investigue la causa raíz.
