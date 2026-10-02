# codex-web-http

Responses API local para Codex: **passthrough nativo** (sin navegador) hoy, y
transporte Web clonado en los siguientes milestones. Plan completo:
`.opencode/plans/codex-web-http.md`.

## Lo unico que viniste a buscar

```bash
cd codex-web-http
bun test          # M2 sin credenciales: mock upstream + TOML con backup
bun run start     # server en http://127.0.0.1:8791
```

## Regla de oro

**La config de Codex se toca solo con `--apply` y siempre con backup.**
Sin `--apply` es dry-run; `--restore` vuelve atras. Nunca se toca
`~/.codex/auth.json`.

```bash
bun run install:codex                          # dry-run (no escribe)
bun run install:codex -- --apply               # escribe con backup
bun run install:codex -- --restore             # restaura el backup mas reciente
```

## E2E vivo (explicito y revocable)

```bash
CODEX_ACCESS_TOKEN=... CODEX_ACCOUNT_ID=... bun run e2e:native
```

Sin token sale `SKIPPED`: el script no lee `auth.json`.

## Estado

- M0 protocolo: `docs/PROTOCOL.md`.
- M2 passthrough nativo + integracion con backup: implementado y testeado.
- M3 catalogo Web clonado (subset visible): implementado detras de flag; el
  matching por cuenta queda pendiente del login (M1). Aviso MIT en
  `THIRD_PARTY_NOTICES.md`.
- M5 streaming/cancelacion/timeout: wrapper SSE tolerante a reset, taxonomia
  de errores y 7 casos de parity (`reports/PARITY.md`).
- M1 (gate HTTP Web) / M4 (transporte): pendientes; M1 requiere login humano.

`CODEX_WEB_HTTP_TIMEOUT_MS` (default 120000) limita solo la fase de headers
del upstream; un stream largo no se corta por ese timeout. Ver
`docs/EVIDENCE.md`.

### Catalogo Web (opt-in)

Hasta que exista el transporte Web (M4), las filas Web se exponen solo si se
piden explicitamente, para que Codex no pueda seleccionar un modelo que aun no
puede responder:

```bash
CODEX_WEB_HTTP_WEB_MODELS=on CODEX_WEB_HTTP_CAPS=sol,extrahigh,pro bun run start
bun run scripts/catalog-diff.ts            # invariantes + parity NOT_DEMONSTRATED
bun run scripts/catalog-diff.ts --reference /ruta/reference-models.json
```

`CODEX_WEB_HTTP_CAPS` acepta `sol`, `extrahigh`, `pro`, `bigger` (default
`sol`). `--reference` compara las filas `chatgpt-web/*` contra una captura de
la referencia y solo pasa si no falta ninguna.
