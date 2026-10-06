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

## Que quedo implementado (M5)

- `codex-web-http/src/responses/stream.ts:1` — wrapper SSE tolerante al cierre
  sucio: reset tras `data: [DONE]` cierra normal; reset antes propaga
  `UpstreamStreamError` (no se inventa un final).
- `codex-web-http/src/responses/errors.ts:1` — taxonomia nombrada
  (`upstream_unreachable`, `upstream_timeout`, `upstream_reset_mid_stream`,
  `client_cancelled`, `catalog_augment_failed`, 404/405).
- `codex-web-http/src/passthrough.ts:1` — timeout de headers
  (`CODEX_WEB_HTTP_TIMEOUT_MS`, default 120 s; el stream no se corta por
  timeout) y propagacion de la cancelacion del cliente al upstream.
- `codex-web-http/tests/parity.test.ts:1` — 7 casos e2e + 2 unitarios.
- `codex-web-http/reports/PARITY.md:1` — resultados y diferencias declaradas.

Salida real:

```text
bun test   -> 22 pass / 0 fail
```

## M1 — Gate HTTP puro: FAIL (2026-10-02)

- Sonda por etapas `codex-web-http/probe/http-probe.ts:1` con Authorization +
  Cookie reales copiados por el usuario.
- Resultado: **403 HTML de challenge Cloudflare en las 3 etapas** (session,
  conversations, f/conversation). No es credencial: es el cliente (fingerprint
  TLS/HTTP2 de Bun vs Chrome).
- Veredicto y análisis: `codex-web-http/reports/H1_HTTP_GATE.md:1`.
- Consecuencia: **M4-B** (browser mínimo con `chrome-headless-shell` +
  pestaña persistente). El passthrough nativo (M2) sigue siendo HTTP puro sin
  navegador con la auth de Codex.
- `~/Development/cookie.txt` (sesión viva) debe borrarse.

## M4-B — Transporte Web: DEMONSTRATED (2026-10-02)

- `codex-web-http/scripts/e2e-web.ts:1` — 3 turnos consecutivos sobre **una
  sola pestaña** con Chrome headless, respuestas exactas (`turno N ok`),
  ~6–10 s por turno, startup 8.2 s.
- Combo stealth necesario para Cloudflare: UA del Chrome real, sin
  `--enable-automation`, `AutomationControlled` off, sandbox on.
- `codex-web-http/scripts/import-cookies.ts:1` — storageState desde el header
  Cookie (el export de Playwright devolvía 0 por encriptado del keyring).
- `chrome-headless-shell`: **NOT_DEMONSTRATED** para 3 turnos (turno 1 OK,
  envíos 2–3 no registraron); su ventaja de RAM se diluye con la SPA cargada.
- Reporte: `codex-web-http/reports/M4_WEB.md:1`.

## Contexto en un solo mensaje: DEMONSTRATED (2026-10-02)

- `codex-web-http/scripts/send-big.ts:1` — 54 KB / 100 KB / 115 KB / 150 KB
  como **un** mensaje por el transporte de pestaña persistente, nonce al final
  verificado en las 4 corridas (15–30 s de respuesta).
- El presupuesto de 110 KB del staging no aplica al texto crudo del composer;
  el techo duro de la ruta es 211 256 chars (Instant). Por encima o fuera de
  budget: adjunto `.txt`; full harness: contexto-por-referencia.
- Reporte: `codex-web-http/reports/CONTEXT_SINGLE_MSG.md:1`.
- Límite honesto: nonce al final prueba el tail, no la integridad del medio.

## No demostrado

- **Parity viva contra la referencia** (un turno real comparado evento a
  evento): NOT_DEMONSTRATED; requiere login M1/M4. El harness de 7 casos ya
  esta listo para esa captura.
- Semantica de reset segun transporte real de internet (aqui es loopback):
  documentada como diferencia de plataforma en `reports/PARITY.md`.
- **Parity por cuenta del catalogo**: NOT_DEMONSTRATED; requiere login M1 y
  capturar `GET /v1/models` de la referencia.
- `/v1/models` aumentado contra el upstream nativo real: requiere auth; los
  tests cubren el merge con fixture y mock.
- E2E vivo contra `chatgpt.com` (requiere token del usuario; `e2e-native.ts`
  lo toma por entorno y hoy sale SKIPPED).
- Transporte Web (M4): depende del gate M1.

## Session bridge nativo (@codex native2) end-to-end: DEMONSTRATED (2026-10-06)

Bridge-only (sin launcher). Session tokens `094571cd` + seleccion de connector
`0e17f51e` + captura robusta `070d147d`.

- Setup: `bun run tunnel:connect` -> tunnel_6aa79054 ready/readyz OK,
  mcp_command = `bun run src/mcp/main.ts --contract native`.
- Sesion real read-only: `isymcp session mint --cwd /home/danny/Development/ISyCo
  --label codex-web-http-e2e` (fp `ead58a0e0a0a`; el token completo vive solo en
  el registro 0600 y en el mensaje del composer, por diseno del connector).
- Evidencia viva (conversacion `6ac4556e-...`, modelo gpt-5.6-sol):
  - `codex_exec ["pwd"]` -> `/home/danny/Development/ISyCo` (cwd de la sesion).
  - `codex_exec ["echo","NONCE-eottxwsv"]` -> `NONCE-eottxwsv` (nonce no
    impronosticable: prueba ejecucion real, no alucinacion).
  - `codex_exec ["touch",".../isyco_write_test.txt"]` -> stderr
    `Sistema de archivos de solo lectura`, `exit code: 1`; el archivo NO existe
    (read-only bwrap demostrado en vivo).
  - Mismo session token en >=4 turnos; pill "Codex ISyMCP" presente en el composer.

Hallazgos:
- El filtro de seguridad de OpenAI bloquea tool calls con shell compuesto
  (`sh -c` + redirects) ANTES de llegar al tunel ("ERROR: Esta llamada a la
  herramienta se ha bloqueado..."). argv simple (`pwd`, `echo`, `touch`) pasa.
- La captura de respuesta falla a veces al recargar una conversacion persistida
  (probe 4: texto vacio a los 240 s con respuestas ya visibles en el DOM).
  Endurecido en `070d147d` (settle + fallback + no-vacio); pendiente un selector
  estable para conversaciones recargadas.
- Probes usados: `/tmp/opencode/e2e-native-probe{1..4}.ts` (no versionados).

No demostrado todavia:
- revocacion en vivo (token revocado -> el siguiente turno no ejecuta);
- `codex_apply_patch` writable en vivo y workspace isolation con sesion writable;
- prueba HTTP-only (M4.12) y failure matrix (M4.13).

## Revocacion y apply_patch (2026-10-06, tarde)

- **Revocacion EN VIVO: DEMONSTRATED.** Misma conversacion `6ac4556e-...`;
  el token ro `ead58a0e0a0a` habia ejecutado nonces antes (control). Luego
  `isymcp session revoke ead58a0e0a0a` -> 1 removida -> el siguiente turno con
  ese token devuelve el recibo stub ("broker not connected (V1 stub)") y NO
  ejecuta (nonce ausente en la respuesta).
- **apply_patch con sesion writable: DEMONSTRATED a nivel MCP con el registro
  real.** `nota.txt` de `/tmp/opencode/isyco-rw-ws` paso de `"hola\n"` a
  `"hola\nmundo ISYMCP\n"`; recibo `executed:true, exit_code:0`. Ademas:
  `git apply` exige newline final -> el MCP ahora normaliza (los modelos lo
  omiten); tests cubren writable ok, escape `..` negado y read-only negado.
- **apply_patch EN VIVO por ChatGPT: NOT_DEMONSTRATED en esta ventana.**
  El turno con patch recibio el recibo stub (probable token mal copiado por el
  modelo en el argumento) y el control con token valido recibio
  `McpServerError: Session terminated` intermitente del tunel. La cuenta esta al
  6% de uso y hubo una "Conexion interrumpida" previa; el mismo MCP con el
  registro real si aplica el patch. Es flakiness del camino tunel/OpenAI, no del
  tool. Reintentar cuando la cuota se restablezca (9 oct) o con cuota disponible.
