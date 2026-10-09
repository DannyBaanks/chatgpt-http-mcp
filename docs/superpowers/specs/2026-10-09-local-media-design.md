# ISyMCP: medios procesados localmente

Estado: implementado localmente el 2026-10-09; audio y fotogramas según ampliación aprobada en el plan. Prueba remota desde ChatGPT: NOT_DEMONSTRATED.

## Intención

Danny quiere dar a ChatGPT.com capacidades explícitas de su computadora: analizar audio y video sin cargar el archivo completo en el chat. El procesamiento queda local y el modelo consulta resultados y regiones por MCP. Debe funcionar desde un chat normal, sin depender de la detección de silencios del modo voz ni de automatizar la interfaz web.

## Integración elegida

Un módulo `src/media/` dentro de ISyMCP y un entry point MCP dedicado `src/mcp/media.ts`. Comparte las utilidades de validación de rutas y trazabilidad cuando sus contratos sean adecuados. No exige un turno Codex, broker ni token de ejecución de comandos para analizar un medio seleccionado. Puede funcionar sin iniciar el servidor que automatiza ChatGPT Web. Reutilizar el túnel Video Vision solo al desplegar y después de verificar la nueva herramienta.

Alternativas: dejar un proyecto independiente duplica operación; añadir todo a `src/mcp/main.ts` acopla medios al contrato de ejecución Codex. El entry point dedicado permite integrar el producto sin ampliar los permisos de comandos.

## Primera entrega

Audio local ya seleccionado por el usuario. CLI `isymcp media add <archivo>` registra el archivo en un catálogo local con un ID opaco, hash SHA-256, tamaño y metadatos. Registro explícito de archivos individuales; el modelo no puede explorar el disco ni elegir rutas arbitrarias. Antes de cada lectura se comprueban identidad del archivo, permisos del catálogo y confinamiento real; cambios posteriores al registro requieren volver a registrarlo. Revocar un ID invalida consultas posteriores y no borra el original.

Herramientas propuestas:

- `media_info(asset_id)`: duración, canales, frecuencia de muestreo, disponibilidad de análisis.
- `audio_analyze(asset_id, start_seconds, end_seconds)`: nivel RMS, picos, intervalos de silencio y espectrograma/onda como imágenes MCP. Máximo 60 segundos por consulta, dos imágenes con máximo 1 MiB cada una. Ventanas inválidas se rechazan sin procesamiento.

El trabajo usa FFmpeg/ffprobe y un worker local, invocados con argumentos separados, sin interpolación de shell. Timeout 60 segundos; concurrencia inicial uno; resultados demasiado grandes se rechazan o reducen explícitamente. Entrada inicial WAV/FLAC/MP3/M4A; archivos de hasta 500 MiB. Los procesos de análisis no requieren red ni acceso a cookies. Cache de derivados en almacenamiento privado del módulo; original de solo lectura. Cada resultado incluye hash de origen, ventana temporal, método y versión, y advertencias de precisión.

## Lo que recibe GPT

Resultados numéricos y gráficos pequeños por respuesta MCP, no el original completo. Esos resultados sí viajan a OpenAI. Un espectrograma permite inspeccionar estructura acústica, pero no demuestra identidad semántica de un sonido ni percepción directa del audio por GPT. Los silencios son datos del análisis, no señales para interrumpir la reproducción o empezar una respuesta.

## Extensiones posteriores

Transcripción local con marcas de tiempo; clasificación local de eventos (voz, música, golpes, gritos) con probabilidades y modelo/licencia identificados; fotogramas coordinados por tiempo; importación explícita de URLs mediante un proveedor separado. La primera entrega no descarga medios remotos, instala modelos grandes, usa claves API ni promete que ChatGPT procese audio nativo devuelto por un MCP. Eso requiere una prueba de compatibilidad separada.

## Licencias

ISyMCP tiene LICENSE MIT de Danny Baanks. Video Vision tiene LICENSE MIT de OA Maestro; cualquier reutilización conserva copyright y licencia. Audio Analysis MCP es público, pero no se encontró LICENSE en el árbol mostrado ni licencia declarada en pyproject.toml: no copiar su implementación sin aclaración del autor. La primera entrega se implementa con dependencias cuya licencia se registre, sin copiar ese proyecto.

## Validación

Pruebas con señales sintéticas: silencio, tono de frecuencia conocida y pulso. Comprobar tiempos, RMS y posición del tono en el espectrograma; errores ante rangos inválidos, archivo cambiado, ID revocado, symlink fuera del ámbito y timeout. Prueba MCP stdio verificando que devuelve imágenes reales y JSON con procedencia. Prueba manual desde ChatGPT mediante el túnel, preguntando por una región de audio registrada. No afirmar compatibilidad de ChatGPT hasta recibir esa respuesta real.

## Operación

Actualizar GUIA.md con registro, consulta, revocación, instalación opcional de dependencias y arranque independiente. Verificación local no modifica el servidor o túnel desplegado. No activar el nuevo proveedor en chats existentes automáticamente.
