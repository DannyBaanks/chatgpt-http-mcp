# Guía del Operador Humano — ISyMCP (ISyCo ChatGPT HTTP Bridge)

```bash
isymcp
```

**Regla:** el puente Web solo se activa para la sesión que lo eligió; levantar
ISyMCP no cambia la ruta global de Codex.

Salida real del menú instalado, recortada, verificada en una terminal PTY:

```text
¿Qué hacemos?
  PUENTE
❯ ▶ Levantar todo  server + tunel
  ■ Detener todo  cierre del server y del tunel
  ↻ Reiniciar  down + up
```

**ISyMCP** convierte tu suscripción de ChatGPT en una interfaz de chat local en localhost, un API compatible con OpenAI / Responses, y una herramienta MCP para tus agentes de código (Codex, Claude Code, Cursor, OpenCode, Copilot CLI, Hermes, OpenClaw, Pi, Gemini).

---

## 1. Requisitos Previos

- **Runtime:** [Bun](https://bun.sh) (v1.4+)
- **Navegador:** Google Chrome o Chromium instalado en el sistema (`/usr/bin/google-chrome` o similar).
- **Aislamiento Sandbox (Opcional pero recomendado):** `bubblewrap` (`bwrap`) para ejecución enjaulada segura de herramientas.
- **Autenticación:** Sesión activa en [chatgpt.com](https://chatgpt.com).

---

## 2. Instalación e Inicio Rápido

### Paso 1: Dependencias y enlace global
```bash
git clone https://github.com/DannyBaanks/chatgpt-http-mcp.git
cd chatgpt-http-mcp
bun install
bun link                      # Hace accesible el comando `isymcp` en tu PATH
```

### Paso 2: Importar cookies de sesión
Exporta tus cookies de chatgpt.com a un archivo seguro (`cookie.txt` con permisos `0600`) y ejecuta:
```bash
bun run scripts/import-cookies.ts --file /ruta/a/cookie.txt
```

### Paso 3: Iniciar el Bridge y el Panel
```bash
# Inicia el servidor bridge en background (:8791)
isymcp server start

# Abre la interfaz visual del panel en http://127.0.0.1:8798
isymcp panel
```

O si prefieres el menú interactivo todo-en-uno desde la terminal:
```bash
isymcp
```

---

## 3. Integración con Codex (Perfiles Aislados y Desacoplados)

ISyMCP implementa una arquitectura **desacoplada**: nunca secuestra ni modifica globalmente tu archivo de configuración `~/.codex/config.toml`. 

Dispones de dos entornos completamente independientes que pueden coexistir en simultáneo:

| Entorno | Comando | Comportamiento |
|---|---|---|
| 🟢 **Codex Nativo** | `codex` | Conecta directo a OpenAI. No depende de ISyMCP ni del bridge local. |
| 🟣 **Codex ISyMCP** | `codex-isymcp` o `isymcp codex` | Selecciona el proveedor propio `isymcp_web` para ese proceso. Un `-m` nativo explícito pasa al Codex normal. |

Comprobación real del acceso instalado, sin iniciar el puente:

```bash
isymcp codex --version
```

```text
codex-cli 0.162.0
```

**Regla:** levantar o reiniciar ISyMCP no debe cambiar la ruta global de Codex.
`models apply` prepara únicamente el perfil y catálogo privados del puente;
`models restore` restaura ese perfil, no un respaldo global antiguo.

### Instalación de lanzadores de escritorio:
```bash
isymcp codex launcher
```
Esto genera el wrapper ejecutable `~/.local/bin/codex-isymcp` y la entrada de escritorio `Codex (ISyMCP Web)`.
El acceso abre el CLI en una terminal y usa el icono de ISyMCP. No abre la App
de Codex ni crea una conversación Web por sí solo.

### Si una sesión vieja sigue en «Reconectando»

Un proceso que ya estaba abierto puede conservar la ruta anterior. Cambiar
`config.toml` no demuestra que ese proceso la haya vuelto a leer. Interrumpe
la petición atascada y cierra el cliente que tiene abierto ese hilo; conserva
su historial. Si otro app-server aún retiene el hilo, no borres su archivo de
candado ni intentes abrirlo simultáneamente desde otro runtime.

Esta variante de recuperación está **NO PROBADA en el hilo retenido**; requiere
que su dueño haya liberado el hilo:

```bash
env -u OPENAI_BASE_URL codex resume --no-daemon -m gpt-6-luna \
  -c 'model_provider="openai"' <id-del-hilo>
```

### Alcance comprobado de esta corrección

Codex CLI 0.162.0 nativo ejecutó un comando y terminó el turno con el puente
apagado. Los tests del lanzador comprueban por separado la selección Web y
el paso de modelos nativos sin cambiar los archivos globales.

**NO PROBADO:** conversación completa de GPT-5.6 Web con herramientas nativas
y flujo de la App. Las comprobaciones del navegador siguen viendo una página
con «Cargando perfil», sin selector de modelo verificable. No se ha demostrado
que la sesión esté vencida. [Resultados y límites](docs/verification/2026-10-09-codex-isolation.md).

---

## 4. Conexión de Agentes y Harnesses (9 Herramientas Soportadas)

ISyMCP detecta e instala automáticamente la herramienta `chatgpt_ask` en tus entornos favoritos de desarrollo:

```bash
# Listar harnesses detectados en el sistema
isymcp harness list

# Ver el plan de instalación (dry-run declarativo)
isymcp harness install claude cursor opencode

# Aplicar la instalación
isymcp harness install claude cursor opencode --apply

# O instalar en todos los harnesses presentes
isymcp harness install --all --apply
```

### Entornos compatibles:
1. **Claude Code** (`claude mcp add`)
2. **OpenAI Codex CLI** (`codex mcp add`)
3. **Cursor IDE** (configuración declarativa JSON en `~/.cursor/mcp.json`)
4. **OpenCode TUI** (configuración declarativa JSON en `~/.config/opencode/opencode.json`)
5. **GitHub Copilot CLI** (`copilot mcp add`)
6. **Hermes Agent** (`hermes mcp add`)
7. **OpenClaw** (`openclaw mcp add`)
8. **Pi Agent** (`pi mcp add`)
9. **Gemini CLI** (`gemini mcp add`)

---

## 5. Streaming de Pensamiento y Razonamiento

ISyMCP soporta streaming en tiempo real del proceso de razonamiento del modelo:

- **En la Web / Panel:** Se muestra una tarjeta animada y colapsable con el pensamiento en curso.
- **En API SSE (`/v1/chat/completions` y `/v1/responses`):** Emite deltas bajo el campo `delta.reasoning_content` (y en formato Responses bajo `thought`).

> [!IMPORTANT]
> **Aviso de Invariante:** El pensamiento capturado corresponde a los **resúmenes e interfaces de razonamiento visibles en el DOM** de ChatGPT Web. No equivale necesariamente a la totalidad de los tokens latentes de la cadena de pensamiento interna (Chain-of-Thought) del modelo.

---

## 6. Telemetría, Métricas y Salud en Vivo

Monitorea la salud del bridge, uso de memoria, latencias y consumo de tokens estimados:

```bash
# Diagnóstico de salud instantáneo
isymcp health

# Telemetría detallada en la terminal
isymcp metrics

# Exportación de métricas en formato Prometheus / OpenMetrics
isymcp metrics --prom
```

Endpoints HTTP disponibles (en `http://127.0.0.1:8791`):
- `GET /api/health` — Estado general, uptime y conexión upstream.
- `GET /api/metrics` — Métricas completas en JSON.
- `GET /metrics` — Formato estándar Prometheus compatible con Grafana / OpenTelemetry.

---

## 7. Verificación E2E Automatizada (`isymcp smoke`)

Para verificar la integridad completa del sistema tras una actualización o cambio de red:

```bash
isymcp smoke
```

Evalúa en una sola corrida:
1. Conectividad y respuesta de salud (`/health`, `/api/health`).
2. Generación y lectura de métricas OpenMetrics (`/metrics`).
3. Detección y estrategias de configuración de los 9 harnesses.
4. Parámetros de aislamiento del lanzador de Codex.
5. Confinamiento de seguridad y autenticación Local Guard.

---

## 8. Compactación y Poda de Contexto

Para evitar desbordar ventanas de contexto en conversaciones muy largas, ISyMCP incluye algoritmos de compactación automática:

- **En Chats (`compactChat`):** Conserva el mensaje inicial/objetivo de la sesión, poda los mensajes intermedios acumulados y mantiene los más recientes con una nota de contexto explícita.
- **En Archivos de Contexto (`compactContextText`):** En textos de más de 500 líneas, conserva el encabezado inicial y las líneas finales omitiendo el cuerpo redundante.

---

## 9. Seguridad y Sandbox (Bubblewrap)

1. **Tokens de Sesión para Herramientas:**
   ```bash
   # Crear token de solo lectura (por defecto, 7 días de validez)
   isymcp session mint --cwd ~/mi-proyecto

   # Crear token con permisos de escritura en la carpeta
   isymcp session mint --cwd ~/mi-proyecto --write

   # Listar y revocar sesiones
   isymcp session list
   isymcp session revoke <token-o-fingerprint>
   ```

2. **Confinamiento:**
   - La raíz del sistema y el `$HOME` del usuario quedan ocultos y montados en modo solo lectura.
   - La red dentro del contenedor está deshabilitada por defecto (activable con `CODEX_WEB_HTTP_SANDBOX_NET=1`).
   - El bridge escucha **únicamente** en la interfaz loopback `127.0.0.1`.

---

## 10. Solución de Problemas Frecuentes

| Problema | Causa Posible | Solución |
|---|---|---|
| **Error 401 en `/health` o `/api/*`** | Variable `CODEX_WEB_HTTP_TOKEN` configurada sin enviar cabecera `Authorization` | Ejecuta `isymcp health` (maneja la auth automáticamente) o exporta tu token. |
| **Error `web_session_expired`** | Las cookies de chatgpt.com caducaron | Vuelve a ejecutar `bun run scripts/import-cookies.ts --file cookie.txt`. |
| **Error `upstream_unreachable`** | Corte de conexión hacia OpenAI | Verifica tu conexión a internet o el estado de ChatGPT. |
| **Túnel desconectado** | ChatGPT no puede llamar herramientas | Ejecuta `isymcp tunnel connect` o reactívalo desde el Panel. |

## Medios locales: audio y video (2026-10-09)

Desde la carpeta de este proyecto, registra el archivo que quieres consultar:

```bash
bun src/isymcp.ts media add /home/danny/Development/video-vision-runtime/angel-engine-test.mp4
```

Salida real de esta instalación:

```json
{"id":"media_b4f26f12-51f0-41ac-832f-af1a2d676184","name":"angel-engine-test.mp4","bytes":351204,"sha256":"766c6551232cb6b1c7494cd285011b19452eae480b6e88c941aaad46d47732ce"}
```

Regla: solo los archivos registrados por ti se entregan al proveedor. Conserva el original; si cambia, registra un ID nuevo. El original queda en tu equipo; las imágenes y estadísticas consultadas sí llegan a ChatGPT.

Lista los IDs disponibles:

```bash
bun src/isymcp.ts media list
```

Salida real (formato compacto):

```json
[{"id":"media_e60fbdfd-85ce-477b-82f3-daa9d2970117","name":"audio.wav","bytes":592510,"sha256":"12f03dde00ed232863125c887f9664c1ed6cf626366fd66a38a6eae00a2ffe89"},{"id":"media_b4f26f12-51f0-41ac-832f-af1a2d676184","name":"angel-engine-test.mp4","bytes":351204,"sha256":"766c6551232cb6b1c7494cd285011b19452eae480b6e88c941aaad46d47732ce"}]
```

Audio de la prueba, registrado desde la extracción local de Angel Engine:

```bash
bun src/isymcp.ts media add /home/danny/.oamaestro/sessions/c0ac235d-21a2-4fb5-a398-354f54f9cd4a/jobs/787fee46-06d2-47fd-b8ad-ee63116503a5/audio.wav
```

Salida real: ID `media_e60fbdfd-85ce-477b-82f3-daa9d2970117`, 592510 bytes, hash indicado arriba. Los IDs cambian con cada registro; no son enlaces públicos ni contraseñas.

El catálogo normal está en `~/.local/state/isymcp/media`; `ISYMCP_MEDIA_HOME` permite otro catálogo. Prueba ejecutada de revocación, en un catálogo temporal independiente:

```bash
ISYMCP_MEDIA_HOME=/tmp/isymcp-media-guide-20261009 bun src/isymcp.ts media revoke media_ca9fafa6-2310-4393-be18-06ef17c377bd
```

Salida: `Asset revoked; original preserved.` La lista posterior quedó `[]`. Para revocar un ID real, usa su ID y el mismo catálogo con que lo registraste. Revocar no elimina el archivo original.

Servidor MCP independiente: `src/mcp/media.ts`. Requiere Bun, FFmpeg y ffprobe en PATH; no exige abrir el bridge web. Video Vision es opcional para audio y obligatorio para fotogramas. Configura `ISYMCP_VIDEO_VISION_ENTRY` con la ruta absoluta de su `dist/index.js`, y `ISYMCP_VIDEO_VISION_NODE` con Node compatible. Esta instalación usa `/home/danny/Development/video-vision-runtime/dist/index.js` y `/home/danny/.local/bin/node`.

Prueba real del protocolo stdio, ejecutada con esas variables:

```bash
ISYMCP_VIDEO_VISION_ENTRY=/home/danny/Development/video-vision-runtime/dist/index.js ISYMCP_VIDEO_VISION_NODE=/home/danny/.local/bin/node bun scripts/media-smoke.ts media_b4f26f12-51f0-41ac-832f-af1a2d676184 media_e60fbdfd-85ce-477b-82f3-daa9d2970117
```

Devolvió un JPEG real para `video_frame` y dos PNG para `audio_analyze`; salida íntegra en `docs/evidence/local-media-20261009-smoke.json`. Las imágenes de esta prueba se guardan en `/tmp/isymcp-*` para inspección.

En ChatGPT, actualiza/reconecta Codex ISyMCP para descubrir `audio_scan` y las demás herramientas multimedia. Prueba humana en ChatGPT con esta versión: **NOT_DEMONSTRATED**; las pruebas locales no la sustituyen. Mensaje para pegar:

> Usa Video Vision. Ejecuta media_info sobre media_e60fbdfd-85ce-477b-82f3-daa9d2970117; después audio_scan sobre toda su pista de audio. Resume la actividad acústica en orden, sin llamarla transcripción ni afirmar que escuchaste palabras. Luego ejecuta video_frame sobre media_b4f26f12-51f0-41ac-832f-af1a2d676184 en el segundo 5. Distingue mediciones, imágenes e interpretaciones.

| Resultado | Significado y acción |
|---|---|
| JSON con hash e imágenes | Consulta local terminada; examina los resultados |
| `isError: true`, worker busy | Espera a que termine la consulta anterior |
| Asset changed / revoked | Registra de nuevo, solo si quieres autorizar ese archivo |
| Invalid window | Usa inicio >= 0 y fin <= duración; audio_analyze y audio_segments aceptan hasta 120 segundos |
| Media has no audio stream | El archivo no contiene audio; registra también el WAV o un video con audio |
| Configure ISYMCP_VIDEO_VISION_ENTRY | Falta configurar el proveedor de fotogramas |
| timed out / exceeds limit | Reduce el intervalo o usa un archivo más pequeño |

Límites: 500 MiB por archivo, una consulta simultánea, 60 segundos para consultas normales y 300 segundos para audio_scan, hasta cuatro imágenes de 1 MiB cada una en modo estéreo separado. WAV/FLAC/MP3/M4A/MP4/MOV/WebM. La consulta utiliza una copia privada verificada y temporal; no expone rutas arbitrarias al modelo. El audio se remuestrea a 16 kHz; los espectrogramas no muestran frecuencias superiores a 8 kHz. Silencio: umbral -50 dBFS, ventanas de 0.1 segundos; no es detección de voz. No incluye transcripción en este entry point. La importación de YouTube se describe en la sección final. El Whisper reparado sigue instalado en Video Vision; este MCP expone gráficos, estadísticas y fotogramas.

Trampas: el MP4 de prueba de 18 segundos es **solo video**; consultar su audio falla correctamente. Tener el túnel listo no prueba una consulta desde ChatGPT. Si el complemento conserva herramientas antiguas, reconéctalo; no le pidas herramientas que no aparecen. Mantén el equipo encendido mientras uses el túnel.

## Usarlo desde Codex ISyMCP (herramientas unificadas)

Selecciona **Codex ISyMCP** y escribe:

> Lista mis medios registrados con media_list. Busca angel-engine-test.mp4 y audio.wav. Analiza los primeros 10 segundos del audio con audio_analyze y muéstrame el fotograma del video en el segundo 5 con video_frame. Distingue mediciones e interpretaciones.

El servidor principal conserva las ocho herramientas `codex_*` y ofrece `media_list`, `media_info`, `audio_segments`, `audio_scan`, `audio_analyze`, `video_frame`, `video_contact_sheet`, `media_import`, `media_import_status` y `media_lookup`. Las herramientas de medios no requieren token de turno. `media_list` entrega hasta 20 archivos registrados por página; sigue `next_offset` si existe. No devuelve rutas locales ni explora archivos no registrados. Para autorizar otro archivo usa `media add` como se describe arriba; para retirarlo, `media revoke`.

El túnel habitual de Codex ISyMCP mantiene su ID y apunta a `src/mcp/main.ts`, con el proveedor Video Vision configurado mediante variables de entorno. No se creó otro complemento ni se modificaron permisos de la cuenta. Actualiza/reconecta el complemento en ChatGPT si todavía muestra solo las herramientas `codex_*`; volver a abrir un chat puede ser necesario para cargar su nueva lista. Prueba remota con la lista unificada: **NOT_DEMONSTRATED** hasta que ChatGPT realmente llame a una herramienta de medios.

Prueba local ejecutada sobre el entry point principal:

```bash
ISYMCP_MEDIA_MCP_ENTRY='/home/danny/Development/ISyCo Git/chatgpt-http-mcp/src/mcp/main.ts' ISYMCP_VIDEO_VISION_ENTRY=/home/danny/Development/video-vision-runtime/dist/index.js ISYMCP_VIDEO_VISION_NODE=/home/danny/.local/bin/node bun scripts/media-smoke.ts media_b4f26f12-51f0-41ac-832f-af1a2d676184 media_e60fbdfd-85ce-477b-82f3-daa9d2970117
```

Salida íntegra: `docs/evidence/unified-media-20261009-smoke.json`. La prueba recibió un JPEG y dos PNG por MCP; la prueba automatizada también verificó que las herramientas de Codex siguen exigiendo su token. La suite completa inicial tuvo un timeout en el E2E existente de 5 segundos; al ejecutarla con `bun test --timeout 15000`, terminó con 291 pruebas correctas y cero fallos. Se conservaron ambos logs.

Si ejecutas de nuevo el script genérico `connect-tunnel.ts` con su comando predeterminado, no conserva automáticamente la configuración de Video Vision: usa un `--mcp-command` que incluya `ISYMCP_VIDEO_VISION_ENTRY` y `ISYMCP_VIDEO_VISION_NODE`, igual que el perfil desplegado. Audio funciona sin el proveedor; video requiere esa configuración.

## Preparar una vez y consultar después

Para dejar listo un video y reutilizar el análisis entre conversaciones, inicia el flujo guiado desde una terminal:

```bash
isymcp media prepare
```

Pega una URL pública de YouTube o Shorts. Después se abre el selector nativo de carpeta (`zenity` o `kdialog` ya instalado), se consulta una vista previa de los metadatos y se pide confirmación antes de descargar. Cancelar cualquiera de esos pasos no inicia una descarga. El flujo solo admite videos públicos individuales: no usa cookies ni listas, y mantiene los límites de 500 MiB y 30 minutos.

El paquete se prepara en tu computadora e incluye el video original, `manifest.json`, el análisis completo de audio en chunks de hasta 120 segundos y hojas 4×4 de 1920×1080 para ventanas consecutivas de hasta 60 segundos. Las hojas contienen fotogramas muestreados y ordenados; no son una extracción exhaustiva ni una reproducción del video. El manifiesto registra URL/ID canónicos, el ID confirmado después de la descarga, datos reales de `ffprobe` y SHA-256 de los archivos. La publicación es atómica, no reemplaza un paquete existente y falla si el sistema no puede garantizarlo.

El catálogo privado continúa siendo la fuente de verdad local. La exportación es una copia en la carpeta elegida; el servidor MCP no acepta rutas arbitrarias. Si se interrumpe la preparación, conserva el origen y los resultados parciales verificados; repetirla puede reutilizar lo válido. Una preparación incompleta nunca reemplaza una generación lista. Al terminar imprime una línea JSON con `asset_id`, `status`, `duration_seconds`, `sheet_count`, `segment_count`, `package_directory`, `source_sha256` y `manifest_sha256`.

También puedes usar el formulario anterior `isymcp media prepare '<url>'` o `bun src/isymcp.ts media prepare '<url>'` para automatizaciones: conserva su ejecución no interactiva y su resumen JSON, pero no abre selector ni exporta paquete. En el menú interactivo `isymcp`, la opción está en **USAR → Preparar video de YouTube…**.

Los manifiestos y artefactos se guardan bajo `~/.local/state/isymcp/media/preparations/` (o bajo `ISYMCP_MEDIA_HOME`) con permisos privados. No se agregan herramientas para aceptar rutas arbitrarias ni se borran originales, generaciones antiguas o resultados parciales.

En ChatGPT, selecciona **Codex ISyMCP** y pide primero `media_lookup(url)`. Si aparece `status: ready`, el modelo recibe el audio segmentado completo y el índice de hojas, pero no las imágenes hasta que solicite `sheet_index`; cada llamada devuelve como máximo una hoja. Si recibe `not_prepared`, puede usar la importación de una sola vez o indicarte que ejecutes `isymcp media prepare`. Si recibe `not_found`, el enlace aún no está registrado. `media_lookup` es de solo lectura: no descarga ni vuelve a calcular. Las mediciones acústicas no son transcripción ni escucha nativa.

Codex ISyMCP es un servidor de herramientas; la respuesta en lenguaje natural la genera el modelo de ChatGPT. Las herramientas de medios se invocan directamente y no necesitan `turn_token`. Las herramientas `codex_*` sí requieren un token de sesión válido: créalo con `isymcp session mint --cwd <directorio>` y pega el `turn_token` junto con `COMANDO: @CODEX ISYMCP`. `codex_turn_start` no crea ese token. Un token inventado o desconocido solo recibe un recibo de compatibilidad y no ejecuta comandos.

## Pegar un enlace para importarlo y analizarlo ahora

Selecciona **Codex ISyMCP** en ChatGPT y escribe:

> Usa Codex ISyMCP para analizar https://www.youtube.com/shorts/lHkDE3BahB0. Primero llama media_lookup. Si ya está preparado, revisa el audio_scan y pide las hojas pertinentes; si no, impórtalo ahora. Examina los primeros 10 segundos de audio con onda y espectrograma y los fotogramas de los segundos 5 y 10. Distingue lo observado de tus interpretaciones.

Si `media_lookup` devuelve `not_found` o `not_prepared` y quieres procesar el enlace inmediatamente, el modelo llama `media_import(url)`, recibe un `job_id` y consulta `media_import_status(job_id, wait_seconds: 10)`. Cuando aparece `state: complete`, usa `asset.id` con `media_info`, `audio_analyze` y `video_frame`. Para guardar la preparación y reutilizarla en futuras conversaciones, ejecuta el comando CLI descrito arriba. La descarga y el procesamiento corren en tu PC; el original no se carga en el chat. Las imágenes y estadísticas solicitadas sí llegan a OpenAI. No requiere un token de turno Codex para las herramientas multimedia.

Prueba real ejecutada sobre el servidor principal:

```bash
ISYMCP_VIDEO_VISION_ENTRY=/home/danny/Development/video-vision-runtime/dist/index.js ISYMCP_VIDEO_VISION_NODE=/home/danny/.local/bin/node bun scripts/media-import-smoke.ts https://www.youtube.com/shorts/lHkDE3BahB0
```

Resultado real resumido (salida completa en `docs/evidence/url-media-20261009-smoke.jsonl`):

```json
{"state":"complete","asset":{"id":"media_122a35ba-e2b1-4da0-bed9-8f14dddd3e2d","name":"media.mp4","bytes":989440,"sha256":"af5d0a6c35ee5b9141e5f9620c9eb79fe38d7791543022b8f4c281df745739af"}}
```

El archivo contiene video 720×720 y audio estéreo a 48 kHz, duración 18.521 segundos. La misma prueba recibió dos PNG de audio y un JPEG real del segundo 5 por MCP. Las gráficas analizan audio mono a 16 kHz, como se documentó arriba.

| Estado de importación | Acción |
|---|---|
| `running` | Consulta `media_import_status`; todavía no hay un resultado para analizar |
| `complete` | Usa `asset.id`; el archivo ya está registrado con SHA-256 |
| `failed` | Informa el error; no afirmes haber visto ni escuchado el video |
| Unknown import job | El servidor pudo reiniciarse o el estado salir del historial de 50 trabajos; busca el archivo en `media_list` |
| Media worker busy | Espera; descarga y análisis comparten un trabajador |

Primera versión: videos individuales públicos de YouTube y Shorts, HTTPS, hasta 30 minutos y 500 MiB. No importa playlists, transmisiones en vivo, sitios arbitrarios ni archivos de redes privadas. Plazo de descarga/validación: 180 segundos; consultas de estado pueden esperar hasta 10 segundos; las consultas normales de análisis tienen 60 segundos y audio_scan tiene 300 segundos. Las ventanas de análisis de audio admiten hasta 120 segundos; audio_scan recorre la pista completa en bloques de hasta 120 segundos. Resolución solicitada de video hasta 720p. Si YouTube exige iniciar sesión o bloquea el enlace, el trabajo falla explícitamente: no usa cookies del navegador.

Reutiliza yt-dlp instalado por Video Vision en `~/.oamaestro/bin/yt-dlp`, o el ejecutable de PATH. `ISYMCP_YTDLP_BIN` permite seleccionar otro ejecutable instalado. No instala ni actualiza automáticamente software; mantiene desactivadas la configuración, los plugins y la caché del descargador. Video Vision sigue proporcionando los fotogramas.

Archivos en `~/.local/state/isymcp/media/downloads/import-*` (o el catálogo configurado). Los originales descargados y los archivos parciales se conservan; revocar un ID no libera espacio ni borra archivos. El trabajador comprueba tamaños durante la descarga, permite hasta 1 GiB temporal para mezclar pistas y exige al menos 64 MiB libres. Al detener el MCP termina también el grupo de procesos de descarga. No reanuda trabajos al reiniciar; los archivos ya registrados permanecen disponibles y puedes volver a importar un enlace fallido. Los estados recientes están en memoria y en un `job.json` local como registro; después de reiniciar usa `media_list` para descubrir medios terminados.

Actualiza/reconecta el complemento para descubrir `media_lookup`, `media_import` y `media_import_status`. **NOT_DEMONSTRATED:** invocación remota desde ChatGPT.com de la preparación persistente o `media_lookup` hasta que se pruebe desde esa conexión. Descarga real y análisis por MCP stdio local sí están verificados.

## Segmentos temporales y canales de audio

`audio_scan(asset_id, start_seconds?, end_seconds?, chunk_seconds?, threshold_dbfs?, merge_gap_seconds?, min_segment_seconds?)` recorre todo el audio local registrado en orden. Si no indicas una ventana, empieza en 0 y llega hasta la duración completa. Divide el análisis en bloques de hasta 120 segundos por defecto; `chunk_seconds` permite elegir un tamaño menor, de 1 a 120 segundos. Devuelve el número de bloques, sus límites, los segmentos de cada uno y sus tiempos absolutos en la pista, junto con los parámetros efectivos. La operación tiene un plazo de 300 segundos. Cada bloque se segmenta de manera independiente, por lo que una actividad continua puede quedar cortada justo en el límite de dos bloques. La herramienta mide actividad acústica; no es transcripción ni escucha nativa.

`audio_segments(asset_id, start_seconds, end_seconds, threshold_dbfs?, merge_gap_seconds?, min_segment_seconds?)` mide RMS en bloques de 10 ms de una mezcla mono a 16 kHz y devuelve intervalos de actividad con RMS y pico por intervalo. Acepta ventanas de hasta 120 segundos. Incluye `algorithm_version: audio-rms-activity/2` para identificar la lógica de segmentación sin cambiar `version: isymcp-media/1`, que identifica el formato general del resultado. Valores predeterminados v2: umbral −32 dBFS, unir huecos de hasta 0.10 s y descartar intervalos menores de 0.12 s. En el Short de referencia, −32 dBFS con fusión de 0.15 s devolvió seis tramos; 0.10 s produjo ocho y separó dos intervalos largos en pausas más pequeñas. Para reproducir la agrupación anterior, especifica `merge_gap_seconds=0.15`. Esto ubica actividad acústica; no distingue habla de música, efectos o ruido. Voces muy bajas pueden quedar por debajo del umbral y las pausas breves pueden dividir una frase; ajusta `merge_gap_seconds` según el material.

Después, solicita `audio_analyze` en una ventana acotada de hasta 120 segundos, por ejemplo 3–5 s, para ampliar la onda y el espectrograma. Su parámetro opcional `channel` acepta `mix` (predeterminado, conserva el análisis mono anterior), `left`, `right` o `separate`. Para fuentes estéreo, `separate` devuelve las medidas y gráficas L/R en ese orden, más correlación Pearson y RMS/pico de la diferencia L−R en la ventana. Estas medidas indican similitud entre canales; no aíslan voz, música ni efectos. Los metadatos diferencian el número de canales fuente y analizados; las etiquetas de cada gráfica dicen `mono mix`, `left` o `right`. Un origen mono responde con error si se solicitan canales L/R inexistentes.

Prueba el análisis completo con `audio_scan` sobre el asset importado. No limites el primer pedido a “los primeros 10 segundos”; si no se especifica una ventana, el MCP recorre la duración completa y divide el trabajo en bloques de hasta 120 segundos. Después selecciona un segmento interesante y pide `audio_analyze` sobre ese intervalo.

Prueba desde ChatGPT, una vez actualizada la lista de herramientas:

> Usa `audio_segments` sobre los primeros 10 segundos del asset importado y reporta todos los intervalos y parámetros. Luego usa `audio_analyze` de 3 a 5 segundos con `channel=separate`. Reporta `pearson_correlation`, `difference_rms` y `difference_peak`; interpreta cuánto se parecen L/R sin llamarlo separación de fuentes, transcripción ni identificación de voces.

La actividad usa 10 ms de resolución; los tiempos resultantes se redondean a milisegundos. La medida de silencio previa conserva su resolución de 100 ms y −50 dBFS. Todas estas son mediciones deterministas, no separación de fuentes ni escucha nativa.

## Hojas de contacto: varios fotogramas en una imagen

Con Codex ISyMCP seleccionado:

> Genera una hoja de contacto 4×4 de los segundos 0 a 18 del video importado de Angel Engine. Recorre los fotogramas de izquierda a derecha y de arriba abajo. Si necesitas un detalle, pide su fotograma con video_frame.

Herramienta: `video_contact_sheet(asset_id, start_seconds, end_seconds, columns)`. `columns` es opcional: 4 por defecto; también 3 o 6. Salida: una imagen JPEG de **1920×1080** y JSON con el índice, fila, columna y tiempo de cada muestra. Intervalo máximo de 60 segundos; se conserva la proporción del fotograma con márgenes negros. Cada celda incluye una banda con su índice y tiempo solicitado.

| Cuadrícula | Muestras | Celda, incluida la etiqueta |
|---|---:|---|
| 3×3 | 9 | 640×360 |
| 4×4 | 16 | 480×270 |
| 6×6 | 36 | 320×180 |

Las muestras se distribuyen uniformemente desde el inicio hasta antes del final. Ejemplo: intervalo 0–18, 4×4 → 0, 1.125, 2.250, …, 16.875 segundos. No equivale a reproducir una animación ni garantiza cubrir cambios entre muestras; pide intervalos más pequeños para estudiar movimientos rápidos. Son tiempos solicitados al decodificador, no una garantía de PTS exacto del fotograma original. Texto y detalles pequeños pueden perderse al reducir; pide una imagen individual para examinarlos.

Prueba ejecutada:

```bash
bun scripts/media-sheet-smoke.ts media_122a35ba-e2b1-4da0-bed9-8f14dddd3e2d
```

Salida completa en `docs/evidence/contact-sheet-20261009-smoke.json`; imagen local en `/tmp/isymcp-angel-contact-sheet.jpg`. La prueba recibió una hoja real de 16 fotogramas de Angel Engine mediante el entry point principal. Límite de imagen: 1 MiB; el JPEG puede comprimir más para respetarlo y reporta su calidad en el JSON. Comparte el worker y plazo de análisis de 60 segundos. Si una muestra no se decodifica, devuelve error en lugar de inventar o rellenar fotogramas.

OCR es otro módulo: Tesseract reconoce texto mediante modelos OCR y no es un LLM. Debe procesar los fotogramas originales antes de reducirlos para la cuadrícula. **Todavía no se integró OCR**; esta herramienta devuelve imágenes y sus tiempos, no transcripciones de texto. Referencia oficial: https://tesseract-ocr.github.io/tessdoc/ . Prueba remota de esta nueva herramienta desde ChatGPT: **NOT_DEMONSTRATED**; refresca la lista de herramientas del complemento después del despliegue.
