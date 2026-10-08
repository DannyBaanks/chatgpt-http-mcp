# Guía del Operador Humano — ISyMCP (ISyCo ChatGPT HTTP Bridge)

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
| 🟣 **Codex ISyMCP** | `codex-isymcp` o `isymcp codex` | Inyecta efímeramente `openai_base_url=http://127.0.0.1:8791/v1`. Accede a modelos Web y verifica que el bridge esté activo. |

### Instalación de lanzadores de escritorio:
```bash
isymcp codex launcher
```
Esto genera el wrapper ejecutable `~/.local/bin/codex-isymcp` y la entrada de escritorio `Codex (ISyMCP Web)`.

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
