# ISyMCP como backend Web de Codex — auditoría y diseño

Fecha: 2026-10-07. Base inspeccionada: `5f1458f8b6b24bec64a1059588686335dac7fda8`.
Codex CLI instalado: **0.160.0**. Este documento propone trabajo; no declara
integración realizada. Compose de Danny: documento local «COMPOSE ISyMCP Codex
App.txt», continuación M7–M19. La conversación intercalada de steer no pertenece
a esta integración.

## Objetivo y límites

GPT.com propone acciones; Codex conserva la ejecución, sus permisos y su sandbox.
ISyMCP transporta y correlaciona. Sin Electron, sin modificar auth, sin ejecutar
herramientas nativas por el sandbox MCP de ISyMCP. Conservar Chat Completions,
chat local, provenance y el flujo nativo. No borrar configuración/cache ni editar
el journal de miuuyy como parte del camino normal.

## Evidencia nueva

1. Una petición con `message(role=user)` y `input_text` produjo prompt vacío y
   HTTP 400 `web_empty_input` contra el código sin modificar. Failing witness:
   `/tmp/isymcp-m7-failing-witness.json`.
2. Codex 0.160.0 ejecutó un turno contra un receptor local, proveedor Responses
   temporal, sin cargar la configuración de usuario ni escribirla. Exit 0.
   Esto demuestra el contrato CLI observado, **no ChatGPT Web ni Codex App E2E**.
3. La petición real contiene `input` con mensajes developer/user y un item
   `additional_tools`. Este contiene herramientas `namespace` y `custom`, entre
   ellas `functions.exec`. No hay campo `tools` tradicional en esta captura.
4. Cabeceras reales: `thread-id`, `session-id`, `x-codex-turn-metadata` y
   `x-codex-window-id`. `client_metadata` también incluye thread/turn; no hace
   falta adivinar identidad a partir de la pestaña. El request tiene
   `prompt_cache_key`; por sí solo no se usará como identidad/autoridad.
5. Lectura Web sin enviar mensaje: modelo visible **GPT-5.6 Sol**, esfuerzo
   **High**, posición 3/3. Esto prueba observación del estado actual; no selección
   automática ni identidad interna del modelo ejecutado.

Los artefactos originales y SHA-256 constan en
`docs/evidence/codex-contract-20261007-manifest.json`. La captura completa queda
local: incluye instrucciones/contexto; no se publicará sin sanitización.

## Matriz antes de implementar

| Superficie | Implementación actual | Contrato/expectativa | Demostración y gap | Cambio mínimo |
|---|---|---|---|---|
| Catálogo | Clona filas y límites de referencia | Filas describen capacidades ejecutables | Catálogo unitario; App no probado | Catálogo propio, sólo capacidades verificadas |
| Input | Omite usuario | Preservar intención actual | Bug reproducido: 400 | Parser explícito, test rojo primero |
| Instructions | Prefijo textual | Conservar rol y orden | Código leído; contexto developer real observado | Envelope con roles; sin elevar usuario a system |
| Task/conversation | HTTP usa pestaña actual; WS sesión default | Una tarea → una URL canónica | Identificadores reales observados, aislamiento no | Binding persistente por thread y contexto |
| Streaming | Delta único tras terminar | Eventos aceptados + granularidad declarada | Fixtures locales; live no | Eventos completos diferidos primero; live después |
| Declaración de tools | Responses ignora tools | `additional_tools` con namespace/custom observado | Declaraciones reales capturadas | Adaptar registro observado; rechazar tipos desconocidos |
| Tool call | Sólo output_text | Codex reconoce llamadas y conserva autoridad | No demostrado | Capturar llamada custom/function y validarla con cliente real |
| Tool result | Omite items estructurados | Resultado correlacionado vuelve al mismo task | No demostrado | Capturar formato real; validar call_id/turn |
| Parallel tools | No implementado en Responses | Codex anuncia parallel_tool_calls | Campo observado; ejecución no | Una llamada secuencial primero; rechazo explícito si necesario |
| Cancelación | Web sin AbortSignal | Distinguir desconexión de efectos | No demostrado | Marcar cancelación; no resend/rollback imaginario |
| Compact | Passthrough nativo también para Web | Contextos equivalentes o error honesto | Código; semántica Web ausente | Interceptar Web y fallar explícitamente hasta verificar |
| Imágenes | Catálogo anuncia; transporte ignora | No pérdida silenciosa | Transporte no demostrado | No anunciarlas; rechazar input_image |
| Effort | Sólo imprime nota | Observar y comparar antes de submit | High observado; guard inexistente | Preconfiguración verificada, fail closed |
| Modelo | Slug nominal | Comparar fila con estado Web | Sol visible observado; vínculo no | Tabla exacta para una fila; verificar dentro del lock |
| Errores | JSON parcial, taxonomías separadas | Componente/fase/retryability | Parcial; NOTICE en PR8 separado | Reutilizar NOTICE cuando esté integrado; tipos Responses |
| WebSocket | Una sesión default; respuestas texto | Mismo contrato e identidad que HTTP | Fixtures, no cliente Web real | Handler común; no rebajar protocolo por WS |
| Retry/idempotency | Chat Completions cachea <500; Responses no | No reenviar tras submit ambiguo | Código leído; garantía Web faltante | Ledger durable con request fingerprint y estado de submit |
| Instalación | Cache/journal legacy; apply puede borrar cache | Plan/diff/backup/apply/restore exacto | App propia no demostrado | Installer propio; detección legacy sólo informativa |
| Native/Web | HTTP passthrough; WS rechaza nativos | Alternar sin romper nativos | Convivencia App no demostrado | Verificar transporte real antes de gateway global |

## Diseño elegido y alternativas

**Elegido:** adaptar Responses para que Codex ejecute las tools, con browser
persistente existente y un binding explícito de tareas. Evita añadir una segunda
fuente de autoridad. Primero HTTP con configuración temporal por proceso.

Un broker por túnel que ejecute por el MCP actual sería reutilizable, pero
violaría el requisito de que Codex sea el ejecutor de este camino. Rehacer el
launcher en Electron no aporta un contrato necesario y está fuera de alcance.

### Unidad 1: M7, fidelidad de entrada

Separar semántica de Responses de chat local. Parser puro que conserva roles,
orden y contenido textual. No asumir que GPT.com ya conoce el usuario. En la
primera petición de tarea, enviar el estado aportado por Codex como envelope
estructurado; en continuaciones, transmitir sólo el delta validado contra el
historial comprometido. Si el prefijo cambia, no adivinar: error de contexto o
nuevo epoch explícito con estado completo, nunca mezclar conversaciones.

`additional_tools` es una declaración de capacidades, no texto de usuario;
conservarla separadamente para M10. No fingir tool support por extraer sus
instrucciones. Unsupported item, imagen o resultado aún no soportado devuelve
error tipado. No perder silenciosamente una parte del input.

Tests: string exacto; usuario solo; instructions + usuario; input_text; rol
assistant/developer preservado; input inválido; parte desconocida; tool result
sin soporte; regresión Chat Completions. El witness viejo debe fallar antes.

### Unidad 2: M8–M9, turno Web aislado y modelo honesto

Binding duradero thread → URL canónica, incluyendo instalación/contexto cuando
sean necesarios. Validar que headers/body no se contradigan. Sin identidad:
error explícito, no `default`. Una tarea nueva navega a conversación nueva;
continuación navega a su URL bajo el mismo lock que selección/submit/captura.

Una única fila inicial: `chatgpt-web/gpt-5.6-sol`, esfuerzo `high`, condicionado
al estado realmente observado. Reutilizar `readComposerSettings` dentro del
lock y después de navegar. No usar un chequeo externo que permita una carrera.
Desactivar connector en este camino para que GPT.com no ejecute tools por MCP.
Si la combinación no puede verificarse, retornar MODEL_STATE_MISMATCH sin enviar.

Ledger: registrar fingerprint de request, task/turn, estado prepared/submitted/
completed/ambiguous y resultado. Mismo request devuelve lo comprometido; mismo
ID con payload distinto se rechaza. Tras crash con submit ambiguo, recuperar
captura o retornar error terminal: no enviar automáticamente otra vez.

Canario real A → B → A → B con nonces distintos y URLs distintas. Primero
cliente CLI; Codex App se mide aparte, no se deduce del éxito CLI.

### Unidad 3: M10, herramientas nativas

Antes de escribir serializador, extender receptor local para emitir una llamada
controlada al cliente Codex instalado y capturar el siguiente request con el
resultado real. Probar custom/namespace y funciones según lo observado; usar el
formato exacto que acepta el cliente, no traducir todo a function_call por memoria.

GPT.com recibe declaración y envelope de respuesta permitido. ISyMCP valida
nombre/tipo/argumentos contra el registro enviado por Codex y genera output
estructurado con call_id estable. Codex recibe y ejecuta. La siguiente petición
se valida contra las llamadas pendientes de la misma tarea y entrega el resultado
al mismo GPT.com. ISyMCP nunca ejecuta ni concede permisos en este recorrido.

No prometer exactly-once global: el ledger del bridge evita regenerar llamadas
en replay; la ejecución es de Codex. La garantía de efectos requiere probar
retry del cliente tras efecto, denial, nonzero, duplicate id, wrong task, crash
y dos llamadas secuenciales. Si el cliente puede duplicar efectos pese a los IDs,
reportar el límite y detener publicación de ese claim.

### Unidades posteriores y gate de publicación

M11: live stream/cancel separados de compatibilidad de eventos. M12: imágenes
no anunciadas hasta E2E. M13: compaction/contexto explicitamente no demostrado
hasta equivalencia. M14: installer propio con plan/diff, backup y restore que
preserva existencia previa y detecta cambios posteriores; legacy journal no se
edita silenciosamente. M15: native → Web → native en App. M16: NOTICE por fase.
M17: App real lee/edita fixture autorizado, corre prueba, muestra resultado;
provocar denial/nonzero y crash seguro. M18: docs con claims acotados. M19:
clasificar legacy; eliminar archivos requiere autorización independiente.

Cada unidad debe tener evidencia/negativos antes de avanzar su gate. No tocar
configuración viva como preparación; la instalación es el último paso revisable
cuando exista un backend demostrado. Reiniciar el gateway puede afectar nativos
si todos usan su base_url: esta limitación se prueba y documenta, no se oculta.

## Estado al cierre de esta auditoría

M7: input fidelity DEMONSTRATED by parser/HTTP/WebSocket regression tests.
The old user-only bug is fixed. Unsupported modalities and tool result items
now fail explicitly before browser submission; tool declarations are preserved
separately. This is not a native tool loop or Web/App E2E.
M8 text E2E y TASK_CONTEXT_ISOLATION: NOT_DEMONSTRATED.
Model/effort: observación visible DEMONSTRATED; enforcement NOT_IMPLEMENTED.
Tool loop/authority/exactly-once: NOT_DEMONSTRATED.
Live streaming/cancel/compaction/long context: NOT_DEMONSTRATED en Responses.
Image input: NOT_DEMONSTRATED; claim actual debe corregirse en implementación.
Installer propio y convivencia native/Web: NOT_DEMONSTRATED.
Codex CLI contra fixture: DEMONSTRATED; Codex App real: NOT_DEMONSTRATED.
Suite M7: 220 pass / 0 fail (31 files), locally verified 2026-10-07.
CI: pending publication of the M7 PR.
PR de implementación: pending publication of the M7 delivery.
