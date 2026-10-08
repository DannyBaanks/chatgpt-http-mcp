# codex-web-http — Protocolo

Estado: CURRENT verificado operativamente.

## 1. Superficie HTTP Local

| Método | Ruta | Función / Destino |
|---|---|---|
| GET | `/v1/models` | Catálogo de modelos OpenAI passthrough + augmentados con `chatgpt-web/*` |
| POST | `/v1/responses` | Reenvío nativo SSE/JSON a `chatgpt.com/backend-api/codex/responses` |
| POST | `/v1/responses/compact` | Reenvío nativo a `chatgpt.com/backend-api/codex/responses/compact` |
| POST | `/v1/chat/completions` | Turno web local compatible con OpenAI para modelos `chatgpt-web/*` |
| GET | `/health` | Chequeo de salud del bridge |
| GET | `/api/health` | Estado de salud estructurado JSON (uptime, upstream, estado) |
| GET | `/api/metrics` | Métricas operativas en vivo (JSON) |
| GET | `/metrics` | Métricas en formato estándar Prometheus / OpenMetrics |
| POST | `/api/action` | Acciones administrativas del panel (confinado a Loopback) |

---

## 2. Streaming y Deltas de Pensamiento

- En endpoints de streaming SSE (`/v1/chat/completions` con `stream: true`), el contenido de pensamiento en vivo emitido por el modelo se transmite mediante deltas con el campo `delta.reasoning_content`.
- Al finalizar el turno de respuesta, se emite `[DONE]`.

---

## 3. Autenticación y Local Guard

- **Loopback Enforcement:** Todas las rutas administrativas y del panel rechazan cualquier solicitud con `Host` u `Origin` que no pertenezca a `127.0.0.1` o `localhost` (protección contra DNS Rebinding y CSRF).
- **Token de Autenticación (`CODEX_WEB_HTTP_TOKEN`):** Cuando esta variable de entorno está definida, todas las solicitudes HTTP requieren la cabecera `Authorization: Bearer <TOKEN>`. Solicitudes no autenticadas devuelven `401 Unauthorized` con detalles accionables en JSON.

---

## 4. Clasificación y Taxonomía de Errores

| Tipo de Error | Status HTTP | Significado |
|---|---|---|
| `chat_invalid_json` / `not_web_model` / `web_empty_prompt` | 400 | Solicitud malformada o modelo no soportado |
| `forbidden_host` / `forbidden_origin` | 403 | Host u Origin fuera de loopback |
| `unsupported_media_type` | 415 | Petición POST sin `content-type: application/json` |
| `web_session_missing` / `web_session_expired` | 401 | Sesión de chatgpt.com no configurada o expirada |
| `upstream_unreachable` | 502 | Servidor de OpenAI inalcanzable |
| `upstream_reset_mid_stream` | 502 | Upstream cortó el flujo antes de enviar la señal `[DONE]` |
| `web_timeout` | 504 | Tiempo de espera agotado en la respuesta del navegador |

---

## 5. Integración con Harnesses y TUIs

- **Codex CLI:** Perfil aislado `codex-isymcp` vía `buildCodexArgs(["-c", "openai_base_url=..."])`.
- **Cursor IDE:** Configuración declarativa en `~/.cursor/mcp.json`.
- **OpenCode TUI:** Configuración declarativa en `~/.config/opencode/opencode.json`.
- **Harnesses CLI (Claude, Copilot, Hermes, OpenClaw, Pi, Gemini):** Invocación mediante `mcp add` nativo de cada herramienta.
