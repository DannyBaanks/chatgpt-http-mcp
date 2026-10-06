# codex-web-http — Protocolo (M0)

Estado: M0 (inventario) + M2 (passthrough nativo) implementados y testeados.
Fuente de comportamiento: `codex-web-gpt-http-cli` @ `324c52c75f1d87c65ee4b94ee71efd2dce1b4ebf`
(MIT). Este documento describe el contrato que nuestro server replica y las
incognitas que resuelven M1/M3/M4.

## Superficie local (nuestro server)

| Metodo | Ruta | Upstream |
|---|---|---|
| GET | `/v1/models` | `chatgpt.com/backend-api/codex/models` |
| POST | `/v1/responses` | `chatgpt.com/backend-api/codex/responses` |
| POST | `/v1/responses/compact` | `chatgpt.com/backend-api/codex/responses/compact` |
| POST | `/v1/chat/completions` | ninguno (turno web local, solo `chatgpt-web/*`) |
| GET | `/health` | — (local) |

Implementacion: `codex-web-http/src/server.ts:1` y
`codex-web-http/src/passthrough.ts:1`.

## Reenvio nativo

- Se reenvian metodo, query, cabeceras y body. Cabeceras hop-by-hop
  (`connection`, `transfer-encoding`, `host`, `content-length`, ...) y
  `accept-encoding` se eliminan; Bun fetch descomprime solo.
- El status y el stream del upstream se devuelven tal cual (SSE incluido).
- Error de red del upstream: `502 upstream_unreachable` (JSON nombrado).
- La auth **no** la gestiona este server: el llamador (Codex) trae su
  `authorization` y `chatgpt-account-id`, que se reenvian. Esto es lo que
  permite el camino sin navegador (plan, `.opencode/plans/codex-web-http.md:117`).

## Integracion con Codex
- `scripts/install-codex.ts` escribe `openai_base_url` top-level en
  `~/.codex/config.toml` (o `CODEX_HOME`), con:
  - default dry-run (no escribe);
  - `--apply` con backup fechado en `codex-web-http/backups/` + journal
    `latest.json`;
  - `--restore` restaura el backup mas reciente.
- Nunca toca `~/.codex/auth.json`.

## Integracion con TUIs (opencode/OpenISy)

opencode consume providers OpenAI-compatibles (`@ai-sdk/openai-compatible`,
que habla `/chat/completions`), asi que el bridge expone
`POST /v1/chat/completions` solo para modelos `chatgpt-web/*` (implementacion
en `src/chat-completions.ts`). Otro modelo falla cerrado con `not_web_model`;
no se reenvia al upstream Codex porque la forma chat no es la suya.

- `isymcp tui list` inventaria TUIs por config dir y/o binario (solo opencode
  es instalable; el resto es inventario).
- `isymcp tui install [--apply|--restore]` escribe `provider.isyco-web`
  (baseURL al loopback, modelos `chatgpt-web/*` con su context window) y
  `mcp.isyco-web-http` (comando local `bun …/src/mcp/main.ts`) en
  `~/.config/opencode/opencode.json`, con backup en `backups/tui/`.
- Verificado 2026-10-04: `opencode models isyco-web` lista 3 filas;
  `opencode run -m isyco-web/chatgpt-web/gpt-5.6-sol-instant` responde;
  `opencode mcp list` muestra `isyco-web-http connected`.
- `limit.output` es techo (= context), no medido por fila: opencode lo exige.
- Empaquetar el MCP para `npx` requiere publicar el paquete: NOT_DEMONSTRATED;
  se usa comando local `bun`.

## Incognitas (resueltas, 2026-10-06)

- M1/M4: transporte elegido por evidencia -> Chrome headless + Playwright con
  pestana persistente; captura HTTP DEMONSTRATED (nonce real). Ver
  `docs/ARCHITECTURE.md`.
- M3: catalogo Web clonado -> `src/web-models.ts` + `/v1/models` en forma OpenAI.
- Error taxonomy e idempotencia: ver la seccion de abajo.
- Cabeceras derivadas que la referencia sintetiza (p. ej. `client_version`
  para `/models`) quedan **fuera** de M2: el cliente actual ya las envia.

## Evidencia de referencia (formato no-cita)

Preferencias del comportamiento observadas en la referencia (commit arriba),
con archivo y numero de linea en prosa, sin sintaxis de cita para no
confundir al cite-check de ISyCo:

- endpoint nativo: `src/native-passthrough.ts` L10;
- rutas locales: `src/server.ts` L1012, L1068, L1082;
- integracion: `src/codex-integration.ts` L284;
- laboratorio de contrato HTTP Web: `src/adapters/chatgpt-web/http-contract-probe.ts` L6.

## Verificacion

```bash
cd codex-web-http
bun test
```

## Error taxonomy (M6, 2026-10-06)

El tipo viaja como prefijo del mensaje (`<type>: detalle`) y mapea a status:

| tipo | status | significado |
|---|---|---|
| `chat_invalid_json` / `not_web_model` / `web_empty_prompt` | 400 | request invalido |
| `web_session_missing` / `web_session_expired` | 401 | sesion/cookies |
| `web_connector_unavailable` | 409 | connector no seleccionable (estado) |
| `web_turn_submit_failed` | 502 | el turno NUNCA se envio |
| `web_capture_empty` / `web_no_response` | 504 | el turno corrio pero no se capturo |
| `web_browser_missing` | 503 | browser no disponible |
| `web_turn_failed` (default) | 500 | interno |

Idempotencia (M5): header `x-isymcp-turn-id` — replay devuelve la misma
respuesta con `x-isymcp-replayed: 1` sin re-ejecutar; 5xx no se cachea.
