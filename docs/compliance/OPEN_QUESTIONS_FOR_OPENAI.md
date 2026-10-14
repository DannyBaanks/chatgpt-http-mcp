# Preguntas de Aclaración para Canales Oficiales de OpenAI

**Documento:** `docs/compliance/OPEN_QUESTIONS_FOR_OPENAI.md`  
**Proyecto:** ISyMCP / chatgpt-http-mcp-impl  
**Fecha:** 2026-10-14  
**Prioridad:** P0 — Account Safety  
**Propósito:** Formular de manera precisa las incertidumbres normativas y técnicas para remitir a los canales de soporte para desarrolladores y políticas de OpenAI (`support.openai.com` / Developer Forum), evitando especulaciones o asunciones de riesgo no fundadas.

---

## 1. Bloqueo de Clasificación de Seguridad en MCP Apps

### Pregunta 1: Criterios del clasificador de seguridad en llamadas de herramientas
* **Contexto:** Durante el uso de una Custom MCP App en modo desarrollador (`asdk_app_*`) conectada a un servidor MCP local, OpenAI devolvió el siguiente error autoritativo:
  > *"Script error: This tool call was blocked by OpenAI because we couldn't determine the safety status of the request."*
* **Pregunta concreta:**
  1. ¿Qué factores determinan que el estado de seguridad de una llamada a una herramienta MCP sea catalogado como "indeterminado" (*unknown*)?
  2. ¿Influye la frecuencia o cadencia de las llamadas sucesivas a herramientas en una misma sesión de chat?
  3. ¿Exige el clasificador de seguridad que el usuario humano interactúe físicamente en la interfaz web entre llamadas consecutivas para validar que no se trata de una ejecución en bucle no supervisada?

---

## 2. Límites y Términos de Custom MCP Apps en ChatGPT

### Pregunta 2: Inicio de turnos versus recepción de llamadas de herramientas
* **Contexto:** La documentación oficial de OpenAI describe las Custom MCP Apps en ChatGPT como conectores donde el usuario en el chat invoca una mención o solicita una tarea, y el modelo invoca herramientas del servidor externo.
* **Pregunta concreta:**
  1. ¿Está permitido formalmente que un proceso local o agente externo envíe una petición al chat para que el modelo responda, o el envío inicial debe ser originado de forma estrictamente interactiva por la persona mediante el teclado del cliente oficial?
  2. ¿Existe algún plan o API oficial prevista para que aplicaciones externas inicialicen una conversación vinculada a un conector MCP sin interactuar con el DOM del navegador?

---

## 3. Arquitectura y Perfilado de Codex Desktop App

### Pregunta 3: Soporte oficial para perfiles y configuración multi-workspace en Codex Desktop
* **Contexto:** Codex CLI documenta claramente el soporte para proveedores personalizados (`model_providers.<id>`) en `config.toml`. Sin embargo, la aplicación de escritorio (`ChatGPT.desktop` en Linux) opera mediante perfiles locales cerrados.
* **Pregunta concreta:**
  1. ¿Admite OpenAI la ejecución de la aplicación de escritorio Codex con directorios `--user-data-dir` personalizados para separar entornos de trabajo de desarrollo local?
  2. ¿Viola la política de autenticación la utilización de las credenciales locales de `~/.codex/auth.json` en una instancia secundaria de prueba en el mismo equipo del usuario?

---

## 4. Canales de Tramitación y Registro de Respuestas

* **Canal 1:** OpenAI Developer Community Forum (`community.openai.com`) en la categoría *API & Platform / Developer Tools*.
* **Canal 2:** OpenAI Support via Help Center (`help.openai.com`) con ticket dirigido al equipo de *Developer Platform Compliance*.
* **Compromiso vinculante:** Mientras no se obtenga una respuesta por escrito afirmativa y oficial para las preguntas 2 y 3, las capacidades correspondientes permanecerán catalogadas como **`DENY`** y **`UNKNOWN`** respectivamente, manteniéndose completamente deshabilitadas en el código operativo.
