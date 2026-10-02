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

## Incognitas para los siguientes milestones

- M1: si un turno Web (`/backend-api/f/conversation`) es reproducible con
  HTTP puro + cookies (plan, `.opencode/plans/codex-web-http.md:97`).
- M3: catalogo Web clonado (Luna/Sol/Pro + efforts) y deteccion por cuenta.
- M4: transporte elegido por evidencia (HTTP o `chrome-headless-shell` con
  pestana persistente).
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
