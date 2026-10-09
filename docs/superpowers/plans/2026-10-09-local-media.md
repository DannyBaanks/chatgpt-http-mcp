# Local audio and video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Procesar video y audio localmente, entregando a ChatGPT resultados pequeños bajo demanda por un MCP dedicado dentro de ISyMCP.

**Architecture:** Catálogo explícito de archivos seleccionados por el usuario; workers locales; servidor MCP de medios independiente del bridge del navegador. Video Vision se integra como proveedor stdio configurable, conservando su procedencia MIT. Audio se implementa directamente con FFmpeg/ffprobe para ondas, espectrogramas y estadísticas; no se copia Audio Analysis MCP sin licencia.

**Tech Stack:** Bun, TypeScript, SDK MCP existente, FFmpeg/ffprobe. Video Vision instalado por separado con sus dependencias locales.

**Spec:** ../specs/2026-10-09-local-media-design.md

## Ajuste aprobado de alcance

Danny pidió implementar video además de audio. Incluir MP4/MOV/WebM en el catálogo y fotogramas mediante el proveedor Video Vision. No descargar URLs desde el modelo en esta primera entrega: el usuario registra un archivo local; la instalación existente puede seguir operando por separado con URLs. No sustituir el túnel activo hasta verificar el nuevo MCP.

## Global Constraints

- Original de solo lectura; registrar archivos individuales con hash e ID opaco.
- Hasta 500 MiB por archivo, 60 segundos por consulta, timeout de proceso 60 segundos.
- Dos imágenes como máximo por respuesta, hasta 1 MiB cada una; resultados JSON pequeños.
- Un trabajo de análisis simultáneo. Sin shell interpolada; sin acceso a cookies.
- Resultados enviados a GPT sí llegan a OpenAI; no prometer percepción de audio nativo.
- El proveedor Video Vision recibe únicamente rutas autorizadas y operaciones seleccionadas. No exponer sus herramientas de limpieza ni rutas arbitrarias.

## Review Focus

Symlinks y archivos cambiados después del registro; llamadas concurrentes; revocación durante análisis; proveedor que devuelve errores como texto; salida MCP enorme. Las pruebas de cada tarea deben cubrir estos casos.

## Task 1: Catálogo y CLI

Files: src/media/catalog.ts, src/media/cli.ts, src/isymcp.ts, tests/media-catalog.test.ts.

Interfaces: addAsset(path) devuelve ID, hash y metadatos; resolveAsset(id) valida integridad y revocación; revokeAsset(id) invalida acceso sin borrar original. Configuración de catálogo mediante ISYMCP_MEDIA_HOME; por defecto directorio privado bajo el estado local de ISyMCP.

- [x] Añadir pruebas de archivo válido, ID desconocido, revocado, cambio de contenido y symlink cambiado.
- [x] Implementar catálogo privado con escrituras atómicas y hashes; controlar actualizaciones concurrentes.
- [x] Añadir isymcp media add/list/revoke; probar comandos con un catálogo temporal.
- [x] Ejecutar bun test tests/media-catalog.test.ts y guardar evidencia; incluir en el commit conjunto documentado en el ledger.

## Task 2: Audio local

Files: src/media/process.ts, src/media/audio.ts, tests/media-audio.test.ts.

Interfaces: probeAsset(asset) devuelve duración y streams; analyzeAudio(asset, start, end) devuelve estadísticas y PNG de onda/espectrograma. Ejecutar procesos con argumentos separados y timeout, limitar salida, producir derivados en directorio privado de cada trabajo. Validar rangos y stream de audio antes de procesar.

- [x] Generar fixtures sintéticos de silencio, tono y pulso dentro del directorio temporal de pruebas.
- [x] Probar estadísticas, tiempos, imágenes reales y ausencia de audio; probar timeout y rangos inválidos.
- [x] Implementar trabajador FFmpeg sin red, tamaños limitados y metadatos de procedencia; impedir nuevas consultas a IDs revocados.
- [x] Ejecutar pruebas de audio y catálogo; incluir en el commit conjunto documentado en el ledger.

## Task 3: Video Vision y servidor MCP

Files: src/media/video-vision.ts, src/mcp/media.ts, tests/media-mcp.test.ts.

Interfaces: proveedor stdio configurable mediante ruta explícita ISYMCP_VIDEO_VISION_ENTRY; extraer fotograma para archivo registrado y tiempo validado. Validar errores semánticos, tipo MIME y tamaño de cada respuesta. MCP tools: media_info, audio_analyze, video_frame; todas usan asset_id y nunca una ruta elegida por el modelo.

- [x] Probar límites de tiempo/tamaño, proveedor no configurado, respuesta de error y concurrentes.
- [x] Implementar cliente de proveedor y registrar herramientas MCP con JSON pequeño e imágenes inline.
- [x] Probar un fotograma de video local y una consulta de audio usando un cliente MCP stdio real.
- [x] Verificar que iniciar medios no requiere servidor web, cookies ni broker Codex; incluir en el commit conjunto documentado en el ledger.

## Task 4: Guía, evidencia e integración

Files: GUIA.md, README.md, NOTICE, docs/evidence/local-media-20261009-manifest.json.

- [x] Documentar registro, consultas, revocación, instalación de proveedor y límites; conservar atribución de Video Vision.
- [x] Ejecutar suite completa bun test y smoke MCP con muestras sintéticas; guardar resultados y SHA-256 sin secretos ni URLs privadas.
- [x] Revisar diff y cambios de contratos; no modificar contratos existentes de Codex.
- [x] Conectar el servidor verificado al túnel Video Vision y comprobar proceso, readiness y control-plane por separado.
- [ ] Probar una consulta real desde ChatGPT con el usuario: NOT_DEMONSTRATED.
- [x] Commit solo de los archivos propios; reportar resultados y límites.

## Execution

Recomendación: ejecución nativa en esta sesión. El catálogo, los workers y el servidor comparten interfaces y caben en una implementación secuencial. No instalar un segundo MCP de audio sin licencia.
