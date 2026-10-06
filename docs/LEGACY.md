# codex-web-http — Legacy / electron audit (M2, 2026-10-06)

Tres claims distintos, medidos por separado:

| Claim | Estado | Evidencia |
|---|---|---|
| Electron no se ejecuta en la ruta | DEMONSTRATED | bridge corre headless sin launcher (E2E nonce `61fcc355`, `closure-1791323388816.json`) |
| Electron no es dependencia de este path | DEMONSTRATED | `package.json` sin electron; `tests/no-electron-dep.test.ts` |
| Browser automation eliminada | **FALSO** | Playwright + Chrome headless son el adapter interno (`src/web-turn.ts`) |

## Clasificación

| Artefacto | Clase | Nota |
|---|---|---|
| Launcher Electron (`~/Development/ISyCo Git/codex-chatgpt-web`, art. 6.1.4) | PROVENANCE_ONLY | repo aparte; nunca re-depender; su `bc94c6c` (session tokens) = referencia de diseño |
| `playwright-core` + Chrome headless | KEEP | adapter web CURRENT (no confundir con Electron) |
| `@modelcontextprotocol/sdk` + `src/mcp/*` (stdio) | KEEP | tools nativas por túnel + stdio local (OpenISy) |
| `--contract safe` / `request_id` (`src/mcp/identity.ts`, `main.ts`) | KEEP (compat) | contrato alternativo; el activo es `native` |
| `--broker-socket` (`connect-tunnel.ts`, `main.ts`) | KEEP (stub declarado) | el flag viaja al túnel; no hay broker implementado |
| Flujo ACK de context-file v1 (`chat-completions.ts`, `context-file.ts`) | KEEP | parte del transporte actual (pull/push) |
| Menciones ACK/lease históricas (`docs/TUNNEL_AND_MODELS.md`) | REFERENCE | fuente de comportamiento MIT; no operativo |
| `~/.codex-chatgpt-web/` (config/binarios del launcher) | PROVENANCE_ONLY | no requerido para operar |
| `~/.nb/context` (session_ref/epoch) | REFERENCE | NO integrado a esta ruta (verificado: `epoch|session_ref` ausente en `src/`) |
| Scripts `install-tunnel|codex|web-models`, `connect-tunnel`, `login`, `import-cookies` | KEEP | operación |
| Scripts `e2e-native|e2e-web`, `send-big`, `catalog-diff` | TEST-ONLY | laboratorio, no producción |
| `docs/EVIDENCE.md`, `docs/PROTOCOL.md`, `docs/TUNNEL_AND_MODELS.md` | KEEP (revisar en M10) | parity pendiente |

## Env vars

Todas las `CODEX_WEB_HTTP_*` inventariadas están en uso (PORT, HOST, UPSTREAM, WEB_MODELS, CAPS,
BROWSER, HEADED, STATE_PATH, CONTEXT_FILE/DIR, TIMEOUT_MS, WEB_TURN_DEADLINE_MS, PASSWORD_STORE,
HOME, CONNECTOR, EXEC_TIMEOUT_MS, SANDBOX) + `ISYMCP_TUI_BASE_URL`. **Sin obsoletas detectadas hoy.**

## Criterio

- No borrar provenance (launcher, docs de referencia) — solo clasificar.
- Nada en este documento autoriza revivir Electron ni payloads gigantes por comodidad.
