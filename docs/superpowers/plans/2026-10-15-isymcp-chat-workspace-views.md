# Panel de chat ISyMCP — plan para integrar las tres vistas reales

> **Para agentes que implementen este plan:** usar la subhabilidad requerida `superpowers:subagent-driven-development` (recomendada) o `superpowers:executing-plans` y avanzar tarea por tarea. Mantener cada casilla como una puerta de entrega.

**Objetivo:** Convertir las tres propuestas visuales en vistas seleccionables y funcionales, todas conectadas al chat, sesiones, ajustes y ejecuciones reales de ISyMCP. La composición de conversación que elegiste será la vista inicial, con el lateral izquierdo solicitado y el Blossom oficial junto a las respuestas de ChatGPT en lugar del botón “IA”.

**Arquitectura:** Un solo panel y un solo estado cliente (chat activo, historial, borrador, ajustes, sesiones y último estado del bridge) con tres representaciones: **Conversación** para el uso diario, **Evidencia** para revisar comprobantes MCP guardados y **Actividad** para observar el turno y bridge en vivo. Cambiar de vista solo modifica la presentación. Los datos siguen saliendo de las APIs actuales; solo se añade una ruta privada para guardar borradores por chat y una correlación por llamada donde la traza actual no es suficiente. Cada icono del lateral conduce a una función existente del producto: chat/historial, sesiones de trabajo, actividad, ajustes y estado del host.

**Tecnologías:** Bun, TypeScript, HTML del panel renderizado por el servidor, script cliente embebido, CSS, APIs JSON locales, traza MCP existente y pruebas Bun.

**Especificación:** Composición de conversación elegida por el usuario + referencia del lateral izquierdo + tres propuestas visuales previas (conversación, comprobantes detallados y actividad de herramientas).

**Estado:** Aprobado para implementación por el usuario el 2026-10-15. Se añadió Tarea 0 tras la corrida base: el import de web-turn ejecutaba chrome.exe --version y abría Chrome en Windows.

## Restricciones globales

- Mantener todos los cambios dentro de `C:\Development\ISyCo Git\chatgpt-http-mcp`; no modificar el repositorio hermano de ISyCo.
- Mantener ChatGPT Web, cookies, estado del navegador, tokens del bridge/sesión, fingerprints de tokens, IDs nativos de threads y registros de traza sin procesar en el backend. Conservar el `fp` opaco que ya usa el selector de sesiones solo como valor interno de configuración; el detalle del chat puede llevarlo para ese selector, pero nunca se muestra ni se incluye en recibos/eventos MCP.
- No inventar ejecuciones, stdout, stderr, duración, modelo, eventos de herramienta ni indicadores de éxito. Si faltan datos o no están disponibles, mostrarlos como tales.
- Conservar el guard de solicitudes `127.0.0.1`, autenticación del bridge, sanitizador Markdown, opt-in de tools por chat, token efímero por turno, límite de historial y rutas existentes `Chat`/`Estado`.
- El Blossom será un avatar pequeño para identificar el origen del asistente y se cargará desde un archivo local exacto y monocromático. ISyMCP seguirá siendo la marca principal; no habrá botón “IA” ni apariencia de respaldo oficial.
- Mantener compartidos el compositor, ciclo de envío y chat activo. Cambiar de vista no debe enviar una solicitud, crear un chat ni cambiar la sesión de tools seleccionada.
- Actividad debe distinguir el chat seleccionado de otro chat que esté usando el único candado global del bridge. No atribuir el estado global al chat equivocado.
- Evidencia solo mostrará campos que la traza realmente conserva. Si no hay salida de comandos guardada, indicará que stdout/stderr no se retienen; no reconstruirlos desde el texto del modelo.
- El bridge real sigue siendo la integración de verdad. Un bridge falso sirve para pruebas deterministas de interfaz, pero no demuestra un canario autenticado con ChatGPT en navegador.

## Criterios de revisión

- Cada una de las tres vistas tiene un propósito distinto y se alimenta de datos guardados o actuales.
- Cada control del lateral tiene un destino o una acción real; ninguno es decorativo.
- Los comprobantes quedan asociados a la invocación correcta, incluso si se repite la misma herramienta.
- El navegador no recibe credenciales completas, tokens, fingerprints de token, IDs nativos de threads, eventos MCP crudos ni stdout/stderr. El valor `fp` existente del selector de sesión sigue siendo únicamente un identificador de configuración no visible.
- Cambiar de vista, cambiar de chat, recargar, usar teclado o reducir el ancho no pierde el chat ni el borrador sin enviar.
- La interfaz conserva la composición elegida, mantiene legibilidad y jerarquía visual, respeta la marca ISyMCP y funciona con teclado y pantallas pequeñas.

---

## Contrato del producto: tres vistas y lateral izquierdo

| Vista | Uso real | Datos y acciones |
|---|---|---|
| **Conversación** (inicial; composición elegida) | Iniciar o retomar una conversación real de ChatGPT, enviar mensajes, seguir la respuesta y modificar los ajustes de ese chat. | APIs actuales `/api/chats`, `/api/chat/status`, `/api/sessions`, `/api/settings*` y `/config` por chat. El historial reciente queda junto al lateral angosto; transcript y compositor al centro; modelo, tools y sesión en inspector o panel compacto. |
| **Evidencia** (propuesta de comprobantes detallados) | Revisar qué herramientas MCP se ejecutaron realmente en una conversación, incluso después de terminar el turno. Filtrar fallos o llamadas completadas y saltar a la respuesta propietaria del comprobante. | `messages[].meta.tools` persistidos, derivados solo de la traza MCP del turno. Mostrar herramienta, resumen real del comando/archivo/ruta, código de salida, duración y error registrado. No mostrar stdout/stderr porque la traza los omite intencionalmente. |
| **Actividad** (propuesta de operaciones en vivo) | Ver si el bridge responde, en qué fase está el turno, cuántos turnos esperan y qué herramientas están ejecutándose, terminaron o fallaron ahora. | Campos actuales de `GET /api/chat/status` (`phase`, `chat_id`, `queued`, `since`, `tools`) y comprobantes guardados del chat seleccionado. Reutilizar el sondeo existente; no agregar una API amplia de trazas crudas. |

Comportamiento del lateral:

- **Chat** abre Conversación y su lista real de chats recientes.
- **Carpeta / Sesiones** abre un selector basado en `GET /api/sessions`. Muestra alcance real (`cwd`), modo lectura/escritura, etiqueta y vencimiento. Elegir una sesión configura el chat actual mediante `/config`, incluso con tools apagadas; encender tools sigue siendo una acción separada y explícita. La acción “crear sesión” copia el comando CLI documentado en vez de fingir que crea una.
- **Terminal / Actividad** abre la vista de operaciones en vivo.
- **Ajustes** abre los controles existentes de modelo/razonamiento y tools, respaldados por `/api/settings*` y `/config`.
- El control inferior de ISyMCP/estado muestra la disponibilidad real del bridge y abre la vista Estado existente. Es un indicador de salud, no una cuenta de usuario ficticia.
- Un selector compacto permite abrir Evidencia además de Conversación y Actividad. La vista elegida se guarda como preferencia local de interfaz; nunca cambia la configuración del backend.

## Tareas de implementación

### Task 0 / Tarea 0 — Evitar abrir Chrome al importar el bridge

- [x] Eliminar la consulta de versión `chrome.exe --version` en tiempo de importación. Mantener el user-agent real calculando la versión desde `browser.version()` después de abrir la instancia de Playwright para un turno solicitado.
- [x] Extraer el formateo del user-agent a una función pura y probar versiones válidas y fallback.
- [x] Añadir una prueba de regresión que importe `src/web-turn.ts` en un proceso Bun con `Bun.spawnSync` vigilado y demuestre cero llamadas a procesos al importar; no abrir ni tocar un perfil de navegador real.

**Archivos:** `src/web-turn.ts`, `tests/web-turn-import.test.ts` (nuevo).

**Puerta:** importar `web-turn.ts` no inicia procesos ni ventanas. Una instancia abierta explícitamente sigue generando el user-agent con su versión real.

---
### Task 1 / Tarea 1 — Fijar el contrato de vistas, límites de privacidad e identidad de comprobantes

- [x] Añadir pruebas para los tres nombres de vista, el valor inicial y el fallback ante una preferencia almacenada desconocida. Los estados vacíos/no disponibles se prueban en la Tarea 3, junto con la UI de Evidencia/Actividad que los presenta.
- [x] Añadir un ID interno por llamada a cada evento MCP `call` y a su `tool.result` correspondiente en `src/mcp/main.ts`. Pasar ese ID explícitamente por la ruta de despacho y resultado; no inferirlo de un objeto de sesión compartido.
- [x] Actualizar `ToolCard` y `toolCards()` en `src/tool-trace.ts` para emparejar internamente por ID de llamada y quitar ese ID antes de devolver o guardar una tarjeta. Mantener compatibilidad con trazas antiguas sin ID y limitar la vista del navegador a la lista permitida (herramienta, resumen, estado, error y solo los campos que la traza realmente conserve: hora, código de salida y duración).
- [x] Mantener las trazas sin tokens completos, stdout o stderr. No incluir `token_fp`, `native_thread_id` ni identificadores de sesión en recibos/eventos MCP proyectados a las nuevas vistas. `session_fp` se permite solo en el detalle del chat para el selector existente, como valor opaco de configuración no visible.
- [x] Conservar tarjetas ya guardadas sin ID; presentarlas como comprobantes heredados sin afirmar que se conoce la correlación exacta por invocación.

**Archivos:** `src/mcp/main.ts`, `src/tool-trace.ts`, `src/chat-turn.ts`, `src/chats.ts` (solo si cambia el tipo de comprobante), `tests/chat-phase2-tools.test.ts` y una prueba enfocada de traza si conviene.

**Puerta:** Las pruebas cubren dos llamadas simultáneas a la misma herramienta con resultados fuera de orden, llamadas en curso, fallos, timeout, líneas incompletas o mal formadas, trazas antiguas y ausencia de secretos/stdout/stderr. Las pruebas actuales de recibos de chat siguen pasando.

### Task 2 / Tarea 2 — Crear el lateral funcional y la composición elegida

- [x] Reorganizar el chat como lateral angosto con iconos, panel de chats recientes, transcript/compositor central e inspector o cajón compacto de ajustes.
- [x] Mantener el orden actual del historial del backend y el comportamiento de nuevo chat, selección, restauración, respuesta en vivo, errores y controles de tools.
- [x] Hacer funcional cada destino del lateral según el contrato anterior. Conservar los enlaces directos `#chat` y `#estado`; las acciones del lateral deben usar el mismo estado de navegación.
- [x] Incluir en `assets/` el asset oficial monocromático exacto del Blossom y anotar su procedencia/uso en `assets/README.md`. Mostrarlo junto a la respuesta del asistente con un nombre accesible descriptivo. Mantener ISyMCP como marca más prominente.
- [x] Servir el archivo con una ruta fija `/assets/openai-white-monoblossom.png` y tipo MIME correcto en `src/panel.ts`. No crear un file server genérico ni permitir rutas de archivo arbitrarias; el guard local actual debe seguir protegiendo la ruta.
- [x] Implementar cajones responsivos para historial, sesiones y ajustes. Añadir etiquetas, estados seleccionado/expandido, foco visible, cierre con Escape, restauración del foco, áreas táctiles y compatibilidad con movimiento reducido.
- [x] Mantener los IDs DOM usados actualmente o actualizar todos sus consumidores de forma atómica; no duplicar controles con el mismo ID.

**Archivos:** `src/panel-chat.ts`, `src/panel.ts`, `assets/openai-white-monoblossom.png` (o el nombre exacto verificado), `assets/README.md`, `tests/panel.test.ts`, `tests/panel-integrations.test.ts`.

**Puerta:** El HTML no tiene botones laterales muertos; selección de chat y ajustes siguen usando APIs reales; la ruta fija entrega el PNG local, sin peticiones remotas ni acceso arbitrario a archivos; los cajones se pueden operar con mouse y teclado en pantallas angostas.

### Task 3 / Tarea 3 — Implementar las tres vistas sobre un mismo estado

- [x] Definir el modelo tipado (`conversation`, `evidence`, `activity`) y un solo estado cliente para chat activo, transcript, borrador, ajustes, sesiones, envío pendiente y último estado del bridge.
- [x] Guardar solo la preferencia de vista en localStorage bajo una clave con namespace; si el almacenamiento no está disponible o el valor no es válido, abrir Conversación.
- [x] Implementar Conversación como vista inicial. Mantener el render de mensajes, sanitización Markdown, botones para copiar, errores, enlaces, controles de tools y actualizaciones en vivo en las mismas funciones de datos y envío.
- [x] Implementar Evidencia como vista histórica del chat seleccionado basada en metadatos persistidos. Añadir filtros de todas/fallidas/completadas, enlaces al mensaje dueño, estados vacíos/heredados honestos y ninguna ruta de traza cruda.
- [x] Implementar Actividad con el endpoint actual de estado y comprobantes del chat seleccionado. Mostrar bridge no disponible explícitamente; mostrar “otro chat activo” si `chat_id` no coincide; no atribuir fase ni cola global al chat incorrecto.
- [x] Reutilizar un solo sondeador de estado. Mantener la frecuencia actual mientras hay un turno pendiente; cuando no lo hay, sondear lentamente solo si Actividad está visible. Evitar fetches simultáneos y detener el sondeo de vistas ocultas.
- [x] Añadir un cajón de sesiones alimentado por `/api/sessions`. Seleccionar una sesión actualiza solo el `session_fp` del chat seleccionado, incluso si tools está OFF, y no habilita ejecución sin la acción explícita del usuario. Validar la sesión en el servidor.
- [x] Ajustar el handler de `/config` para validar y guardar una sesión seleccionada también cuando tools está OFF, manteniendo el switch como la única acción que habilita ejecución. Probar que un `session_fp` inválido se rechaza y que el estado OFF nunca ejecuta herramientas.
- [x] Anunciar cambios de estado importantes con una región accesible moderada; no anunciar cada segundo ni cada fragmento de texto.
- [x] Probar los estados vacíos y no disponibles de Evidencia/Actividad, incluidos bridge fuera de línea, sin recibos, recibos heredados y actividad perteneciente a otro chat.

**Archivos:** `src/panel-chat.ts`, `src/panel.ts`, `src/tool-trace.ts` (solo proyección de comprobantes), `tests/panel-chat-modes.test.ts` (nuevo), `tests/chat-phase2-tools.test.ts`.

**Puerta:** Las tres vistas usan el mismo chat y transcript; cambiar de vista solo cambia la presentación; historial, ajustes y herramientas se actualizan desde APIs/registros reales; actividad de otro chat, bridge no disponible, ausencia de comprobantes y tarjetas antiguas se etiquetan con honestidad.

### Task 4 / Tarea 4 — Conservar borradores durante el uso real del chat

- [x] Añadir un campo opcional y acotado `draft` al registro privado de chat. Registros `isymcp.chat/1` anteriores deben cargar con borrador vacío.
- [x] Añadir `POST /api/chats/:id/draft` con validación JSON y límite de longitud. Incluir el borrador solo en el detalle del chat seleccionado; excluirlo de metadatos de lista y de toda solicitud al bridge.
- [x] Guardar con debounce y serialización por chat para impedir que una petición antigua reemplace texto nuevo. El flush de `pagehide` omite la cola, usa una revisión creciente y el servidor descarta revisiones obsoletas. Restaurar texto y selección al volver al chat o cambiar de vista. Al enviar, limpiar solo el borrador exacto enviado después de un éxito; conservarlo tras un fallo o si el usuario escribió algo más mientras esperaba.
- [x] Al abrir otro chat, limpiar el compositor/transcript visibles y deshabilitar el envío mientras carga el detalle; una respuesta vieja no puede asociar texto visible al chat nuevo.
- [x] Mantener el texto previo a tener un ID de chat en la pestaña actual; no crear chats silenciosamente solo por enfocar o escribir en el compositor.

**Archivos:** `src/chats.ts`, `src/panel.ts`, `src/panel-chat.ts`, `tests/chat.test.ts`, `tests/panel-chat-modes.test.ts`.

**Puerta:** Las pruebas cubren registros antiguos, límite de tamaño, privacidad en listas, cambio de chat, recarga, orden de guardados, éxito/fallo de envío y prueba de que el borrador no se manda al bridge antes del envío explícito.

### Task 5 / Tarea 5 — Verificar todo el panel y documentar lo que realmente presenta

- [x] Añadir cobertura determinista de API/interfaz con bridge local falso: servidor del panel, selección real de chat, cambio de vistas, selección de sesión, envío exitoso/fallido, actividad de herramienta y restauración tras recargar.
- [x] Revisar interacción y aspecto en escritorio (1440 px), tableta (aprox. 900 px) y teléfono (390 px): navegación lateral, foco de cajones, bloques de código largos, evidencia vacía, herramienta en curso y bridge apagado.
- [x] Ejecutar primero las suites enfocadas y luego la suite del repositorio: `bun test --timeout 15000 tests/panel-chat-modes.test.ts tests/chat-phase2-tools.test.ts tests/chat.test.ts tests/panel.test.ts tests/panel-integrations.test.ts`, seguido por `bun test --timeout 60000`. La suite enfocada pasó; la completa se ejecutó, pero este host Windows registró 85 fallos ajenos a los archivos del panel; se preservaron en el informe de verificación.
- [x] Probar el panel contra el bridge local real y hacer un turno benigno autenticado desde navegador con tools apagadas; comprobar aparte un comprobante con tools activadas solo en una sesión de prueba con escritura autorizada. Guardar comando, salida exacta y código de salida. Si faltan login/bridge/navegador autenticados, registrar ese canario como `NOT_DEMONSTRATED`; una prueba con bridge falso no cuenta como éxito real con ChatGPT.
- [x] Actualizar `README.md` y `GUIA.md` con las tres vistas, qué campos son reales, límite de retención de comprobantes (proyección local de 200 mensajes), ausencia de stdout/stderr, procedencia local del logo y comportamiento verificado de teclado/móvil.
- [x] No hacer commit, push ni abrir el PR de interfaz hasta completar la implementación y la revisión fresca. Los fallos globales del host se reportan con evidencia; no se presentan como una suite completa aprobada. El PR #31 de soporte Windows ya se fusionó en `main`; este PR de interfaz se prepara sobre `main` e incluye ese estado.

**Archivos:** `tests/panel-chat-modes.test.ts`, pruebas existentes de panel/chat, `README.md`, `GUIA.md` y los archivos de implementación anteriores.

**Puerta:** Las pruebas enfocadas y E2E del panel pasan; la suite completa se ejecuta y sus fallos se informan honestamente; el diff no tiene errores; la revisión escritorio/móvil tiene capturas hasheadas; el canario real pasa o queda marcado `NOT_DEMONSTRATED`; la documentación coincide con el comportamiento observado. Informe: `docs/verification/2026-10-15-panel-chat-views.md`.

## Definición de terminado

- El usuario puede alternar entre Conversación, Evidencia y Actividad sin perder chat, transcript ni borrador pendiente.
- Chat, Sesiones, Actividad, Ajustes y Estado del lateral conducen a datos o acciones reales.
- La respuesta usa el Blossom oficial local; no hay botón “IA” e ISyMCP sigue siendo la marca principal.
- Cada comprobante visible proviene de la traza o del chat guardado; las llamadas nuevas se correlacionan con exactitud y las antiguas se identifican como heredadas.
- Ninguna ruta nueva expone trazas MCP crudas o tokens; los controles locales y autenticación actuales siguen pasando.
- Pruebas, revisión visual, canario de integración y guía distinguen claramente lo que pasó de lo que sigue `NOT_DEMONSTRATED`.
