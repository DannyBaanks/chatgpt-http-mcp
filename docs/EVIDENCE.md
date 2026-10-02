# codex-web-http — Evidencia (M0/M2)

Fecha: 2026-10-02.

## Versiones y procedencia

| Que | Valor |
|---|---|
| Bun | 1.4.2 |
| codex-cli | 0.155.1 (`~/.local/bin/codex`) |
| Referencia | `codex-web-gpt-http-cli` @ `324c52c75f1d87c65ee4b94ee71efd2dce1b4ebf`, MIT |
| `~/.codex/auth.json` | presente (via nativa disponible); no se lee en tests |
| `~/.codex-chatgpt-web/browser/storage-state.json` | **ausente** (falta login para M1) |

## Mediciones propias usadas por el plan

- `chrome-headless-shell` lanzado por el `playwright-core` de la referencia:
  stack completo **225 MB PSS** vs **397 MB PSS** del Chrome full
  (`about:blank`, PSS via `/proc/*/smaps_rollup`).
- NB contra `https://chatgpt.com/`: **403** challenge Cloudflare; detalle en
  `nb/evidence/L1-LINUX-RESULTS.md:1`.
- Plan de referencia: `.opencode/plans/codex-web-http.md:1`.

## Que quedo implementado (M2)

- `codex-web-http/src/config.ts:1` — config por entorno, upstream por default
  `https://chatgpt.com/backend-api/codex`.
- `codex-web-http/src/passthrough.ts:1` — reenvio con filtrado hop-by-hop y
  `502` nombrado si el upstream no responde.
- `codex-web-http/src/server.ts:1` — `/v1/models`, `/v1/responses`,
  `/v1/responses/compact`, `/health`; 404/405 JSON.
- `codex-web-http/scripts/install-codex.ts:1` — edicion TOML con dry-run,
  backup y restore.
- Tests: `codex-web-http/tests/passthrough.test.ts:1` (mock upstream, SSE,
  errores, hop-by-hop) y `codex-web-http/tests/install-codex.test.ts:1`
  (TOML, backup, restore) — sin credenciales ni tocar `~/.codex`.

## Que quedo implementado (M3)

- `codex-web-http/src/web-models.ts:1` — subset visible del catalogo Web
  clonado (Luna / Instant / Sol / Pro / GPT-6 Pro): gating por capabilities,
  efforts por ruta y limites de contexto (Luna 1 050 000; instante 41 000/32 000;
  medium/high 90 000/80 000; Pro 111 193/112 193 con compact 95 000; bigger
  context x3). Derivado de la referencia MIT: aviso en
  `codex-web-http/THIRD_PARTY_NOTICES.md:1`.
- Flag `CODEX_WEB_HTTP_WEB_MODELS=on` (default `off`) + `CODEX_WEB_HTTP_CAPS`
  en `codex-web-http/src/config.ts:1`; `/v1/models` aumenta el catalogo nativo
  solo cuando esta encendido, y falla cerrado (`catalog_augment_failed`) si el
  upstream devuelve algo invalido.
- `codex-web-http/scripts/catalog-diff.ts:1` — invariantes + diff de filas
  contra una captura de referencia (`--reference`).
- Fixture propio (no copiado): `codex-web-http/fixtures/native-models.sample.json:1`.
- Tests: `codex-web-http/tests/catalog.test.ts:1` (gating, limits, augment sin
  mutar, template obligatorio, diff).

Salida real del verificador:

```text
bun test                              -> 13 pass / 0 fail
bun run scripts/catalog-diff.ts       -> invariantes: OK
                                         parity viva: NOT_DEMONSTRATED (requiere login M1)
```

## No demostrado

- **Parity por cuenta del catalogo** (filas exactas que la referencia expone
  para esta cuenta): NOT_DEMONSTRATED; requiere login M1 y capturar
  `GET /v1/models` de la referencia.
- `/v1/models` aumentado contra el upstream nativo real: requiere auth; los
  tests cubren el merge con fixture y mock.
- E2E vivo contra `chatgpt.com` (requiere token del usuario; `e2e-native.ts`
  lo toma por entorno y hoy sale SKIPPED).
- Transporte Web (M4): depende del gate M1.
- Paridad de contrato Responses: pendiente de M5.
