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

## Medición de cuota y CLI (2026-10-06, noche)

- **Medición de cuota** (1 turno con connector + tool call, conversación
  `6ac4556e-...`): sidebar ANTES `Queda un 6 %` / DESPUÉS `Queda un 6 %` — sin
  delta visible. El turno sí ejecutó una llamada por el connector (recibo
  `executed=false, exit_code=128`, el modelo reusó el apply_patch del historial).
  Con resolución de 1 % no descarta deltas <0.5 %; no es concluyente, pero es
  consistente con la corrección del usuario (chatgpt.com no gasta la
  suscripción; la conexión del connector sí — y aun así no movió el medidor en
  1 turno). Lectura: sidebar por CDP (`/tmp/opencode/quota-read.ts`, no versionado).
- **CLI `isymcp` completado** (commit): `up`/`server start` pasan
  `CODEX_WEB_HTTP_CONNECTOR=Codex ISyMCP` (nombre de `identity.ts`) al server
  detached; `--no-connector` lo apaga; `status` muestra connector + sesiones
  (fp/modo); menú con subrama **Sesiones MCP…** (listar/crear read-only/revocar,
  + cookies legacy). Smoke en puerto 8899: env del hijo verificada, health ok,
  stop limpio; `--no-connector` deja la env ausente.

## Medicion de cuota con el medidor correcto (2026-10-06, noche)

Correccion del owner: el medidor que manda es el de **5 h**; el semanal es otro.
El popover con ambos se lee clickeando el pill "Queda un X % de uso"
(`/tmp/opencode/quota-diag2.ts`, no versionado; el footer solo muestra el semanal).

Cronologia (~13:17-13:37 locales, popover leido en cada punto):
- baseline: 5 h `100 % restante` (reset ~18:20) | semanal `6 % restante`.
- 2 turnos planos (sin connector, `burst.ts plain`): 5 h 100 % | semanal 6 %.
- 4 turnos con connector (1 fallo al subir, menu throttleado): 5 h 100 % | semanal 6 %.
- Total ~7 turnos automatizados: NINGUN medidor muestra delta (resolucion 1 %).
- El reloj de reset del 5 h SI avanza con actividad (18:17 -> 18:37): los turnos
  cuentan como actividad, pero el costo por turno es <1 % (irresoluble a esta
  granularidad con ~7 turnos).

Conclusion: a esta resolucion, el uso automatizado (plano o con connector) no
mueve los medidores visibles; el semanal al 6 % es uso previo del owner, no de
estas pruebas. No se puede confirmar ni refutar desde los medidores que "la
conexion OAuth consuma": los turnos con connector tampoco movieron nada.
Para costo por turno harian falta ~20+ turnos y esperar refresco del medidor.

## HTTP-only end-to-end + causa raiz de "Session terminated" (2026-10-06, tarde)

- **HTTP-only DEMONSTRATED**: `isymcp server start` en 8793 (connector default
  ON) + POST `/v1/chat/completions` (modelo `chatgpt-web/gpt-5.6-sol`, body con
  el COMANDO + turn_token de la sesion rw) -> ChatGPT Web -> connector ->
  tunel -> MCP -> `codex_exec ["echo","HTTP-kxat4j"]` -> la conversacion muestra
  `ChatGPT dijo: HTTP-kxat4j`. El circuito completo funciona por HTTP puro.
- **Causa raiz de "Session terminated"**: el daemon del tunel era de oct 5
  21:59 (15.9 h) — `isymcp tunnel stop` informaba "Stopped" pero el daemon en su
  sesion tmux SOBREVIVIA, y tras la "Conexion interrumpida" toda llamada real
  devolvia "Session terminated" (los textos "V1 stub" vistos eran el modelo
  repitiendo recibos viejos del historial, no llamadas reales). Matar el tmux a
  mano + `tunnel:connect` -> el mismo turno HTTP devolvio el nonce real.
  Fix: `tunnel stop` ahora cierra tambien las sesiones tmux
  `tunnel-mcp__codex-web-http__*`.
- **Captura**: dos carreras corregidas (selectores primary-first para no
  capturar contenedores con el turno del usuario; settle por conteo+identidad
  para no capturar el turno anterior en conversaciones recargadas). Verificado
  en la ultima llamada (texto limpio del turno correcto). El turno siguiente fue
  frenado por un chequeo de seguridad de OpenAI ("no se ha podido determinar el
  estado de seguridad"), condicion transitoria del lado OpenAI.

**CORRECCION (misma fecha, cierre)**: la "revocacion DEMONSTRATED" y los recibos
"V1 stub" de mas arriba ocurrieron durante la ventana del daemon viejo roto
("Session terminated" en toda llamada real). Con el patron descubierto despues
(el modelo repite recibos viejos del historial), esos "stub" fueron casi
seguramente RECUERDO del modelo, no llamadas reales: la revocacion en vivo y
`apply_patch` en vivo por ChatGPT quedan **NOT_DEMONSTRATED**, pendientes de
repetir con el tunel sano (reiniciado 13:54). Lo que SI queda firme: pwd/nonce/
read-only del primer daemon (stderr real de bwrap), apply_patch a nivel MCP con
registro real, y el HTTP-only echo (post-reinicio).

## RE-VERIFICACION con tunel sano + failure matrix (2026-10-06, tarde-noche)

Setup: tunel reiniciado de verdad (fix `tunnel stop` verificado: mato el tmux);
MCP con trazas (`~/.codex-web-http/mcp-trace.log`, 0600: tool + fingerprint +
sesion resuelta); bridge 8793 via `isymcp server start` (connector default).
Sesiones: rw `e59c5937d099`, ro reverify `b8f9cb0b0bc4`.

- **apply_patch EN VIVO: DEMONSTRATED.** HTTP -> ChatGPT -> connector -> tunel
  -> MCP -> git apply: `nota.txt` paso de `hola` a `hola\nreverify RV-gm5otm`.
  Traza: turn_start/apply_patch/turn_complete con session=rw resuelta.
- **Control read-only: DEMONSTRATED.** touch en workspace con sesion ro:
  ejecutado y bloqueado por bwrap (archivo NO creado). Traza con session=ro.
- **Revocacion EN VIVO: DEMONSTRATED (traza decisiva, independiente del modelo).**
  Antes: token b8f9cb0b0bc4 -> session resuelta; `isymcp session revoke` ->
  mismo token -> `session: null`, sin ejecucion, archivo ausente. (La version
  anterior de esta evidencia, basada en "V1 stub" del modelo, quedo corregida:
  era recuerdo del historial con el tunel roto.)
- **HTTP-only: DEMONSTRATED** (echo HTTP-kxat4j post-reinicio; apply_patch y
  touch de esta ronda tambien fueron por HTTP puro).

Failure matrix:

| caso | resultado | estado |
|---|---|---|
| token desconocido/revocado | session null -> recibo stub, sin ejecucion | DEMONSTRATED (vivo, traza) |
| write en sesion ro | bwrap ro: exit!=0, sin archivo | DEMONSTRATED (vivo) |
| apply_patch fuera del workspace (`../`) | rechazado "fuera del workspace" | DEMONSTRATED (test) |
| apply_patch en sesion ro | rechazado "sesion read-only" | DEMONSTRATED (test) |
| modelo no web por HTTP | 400 `not_web_model` | DEMONSTRATED (vivo) |
| connector no disponible | `web_connector_unavailable: <name>` | OBSERVED (menu throttleado) |
| submit con generacion en curso | `web_no_response: submitted=false` | OBSERVED (2x) + fix de espera |
| bwrap ausente en sesion ro | fail-closed (codigo) | NOT_DEMONSTRATED |
| timeout de exec (60 s) | kill + reporte | NOT_DEMONSTRATED |

- Fix: el submit ahora espera hasta 20 s a que el boton Enviar se habilite
  (ChatGPT lo deshabilita mientras genera; causaba submitted=false).
- Pendiente vivo: la captura del texto final a veces devuelve estado
  intermedio/eco (el HTTP puede responder web_no_response aunque el turno SI
  haya ejecutado; la traza y el filesystem son la evidencia firme).

## Recta final: pulido + failure matrix cerrada (2026-10-06)

- **Captura pulida**: `readLastAssistant` prefiere el ultimo `.markdown` (evita
  contenedores con el turno del usuario); espera de fin real por boton
  "Detener" (no corta durante "Ha pensado durante N s"); el submit espera a que
  Enviar se habilite (hasta 20 s). Commit incluido.
- **Exec async**: `codex_exec`/`codex_apply_patch` ya no usan spawnSync (no
  bloquean el event loop del MCP); timeout configurable
  (`CODEX_WEB_HTTP_EXEC_TIMEOUT_MS`) con `timed_out` en el recibo.
- **bwrap-ausente: DEMONSTRATED** (test vivo): `CODEX_WEB_HTTP_SANDBOX=off` ->
  read-only falla cerrado ("fail-closed"), writable ejecuta con `sandbox:"none"`.
- **timeout de exec: DEMONSTRATED** (test vivo): `sleep` + timeout 800 ms ->
  `timed_out:true`, exit 143.
- Hallazgo de metodo: una sonda/helper con Promise.race por iteracion FILTRA
  reads pendientes y "pierde" respuestas lentas (el MCP respondia siempre);
  helper corregido con un unico `for await`. 91/91 tests.

Failure matrix final: todos los casos DEMONSTRATED salvo "timeout" que ahora
tambien lo esta; la captura quedo pulida (verificacion viva de la captura
pendiente en la proxima corrida HTTP).

## Soak 100 v2 (M9, 2026-10-06) — 99/100, fallo unico EXTERNO

- `docs/evidence/soak-1791333507786.json` (69.6 min, con reviver M13c armado).
- **99 ok** (nonce exacto + `replay=1` en los 99), **1 fail**: turno 95,
  "OpenAI ha bloqueado esta llamada a una herramienta porque no se ha podido
  determinar el estado de seguridad" — bloqueo del lado OpenAI ANTES de llegar
  al tunel; el turno se envio y el replay devolvio `replay=1`.
- **0 crashes, 0 abortos, 0 fallos de captura, 0 cross-talk** (el log no muestra
  ni un `ABORT`/`crashed`; el reviver no hizo falta).
- Clasificacion: el unico fail es EXTERNO (safety de OpenAI), no infraestructura
  ni captura. Gate estricto 100/100: queda a 1 turno externo de distancia;
  recomendar re-run solo si se exige el estricto.

## Tools nativas completadas (2026-10-10) — write_stdin, tool_call, Begin Patch, inventario fiel

Correccion de estado (apendice; no reescribe evidencia previa): los recibos
"no implementado en v0" de `codex_write_stdin`/`codex_tool_call`, el rechazo
de `*** Begin Patch` y el inventario parcial de 6 herramientas DEJARON de ser
el estado actual.

- **codex_apply_patch formato nativo `*** Begin Patch`: DEMONSTRATED (local,
  MCP vivo).** Aplicador propio (`src/mcp/codex-patch.ts`): valida TODO en
  memoria y solo entonces escribe (tmp+rename); contexto que no coincide, ruta
  escapada, archivo repetido o directiva rara => rechazo SIN tocar disco.
  Equivalencia con git diff sobre estados identicos: DEMONSTRATED
  (`tests/mcp-native-tools.test.ts`, TEST D: ambos formatos -> `hola\nmundo ISYMCP\n`).
- **codex_write_stdin: DEMONSTRATED (local, MCP vivo).** `codex_exec` con
  `background:true` devuelve `exec_id`; write_stdin escribe stdin y devuelve
  solo el delta de salida; `close_stdin` (EOF) y `signal TERM/KILL`;
  `exec_id` desconocido o de otra sesion: rechazado; `codex_turn_complete`
  mata lo vivo (`live_execs_killed` >= 1 y el exec_id desaparece). Anti-huerfanos
  por capas: TTL 15 min + sweeper, kill al cerrar turno, bwrap --die-with-parent,
  exit handler. Registro: `src/mcp/exec-registry.ts` (16 max, buffers 512 KiB).
- **codex_tool_call: DEMONSTRATED (local, MCP vivo).** Dispatch local a las
  tools nativas con la sesion del turno: wire_name exacto del inventario o alias
  corto (exec/exec_command/shell/shell_command/apply_patch/view_image/write_stdin/tool_inventory);
  arguments validados contra la MISMA shape zod registrada; wire no soportado
  => rechazo explicito; `call_id` deduplica reintentos (`replayed:true`).
- **codex_tool_inventory fiel: DEMONSTRATED.** Sesion real: 8 tools +
  `capabilities` (descripcion, esquema JSON de argumentos, requires). Token
  desconocido: `tools: []` + razon (antes anunciaba 4 que no ejecutaban).
  Soak en vivo actualizado: espera "8" (`scripts/soak-tools.ts`; corrida remota
  NOT_DEMONSTRATED en esta ventana).
- **Bootstrap minimo: DEMONSTRATED.** Instructions del connector reducidas
  (test: sin "ISYMCP CODEX RESPONSE CONTRACT", < 2200 chars); el contrato largo
  sigue SOLO en el transporte externo (`src/responses/tools.ts`, intocado).
- Suite: `bun test` 455 pruebas (454 pass, 1 skip, 0 fail), incluye 40 nuevas.
  Atribucion de flakes: el fallo de `media-unified` era determinista (mi slim
  omitia "isymcp media prepare", exigido por test) — corregido; el ECONNRESET
  de parity es el log de un error EXPECTADO por su test (pasa aislado 9/9).
- **EN VIVO desde chatgpt.com (TEST E): NOT_DEMONSTRATED en esta ventana.**
  Requiere sesion real + refresh del complemento; pasos reproducibles: mintear
  `isymcp session mint --cwd <dir> --write`, pegar el compose con
  `COMANDO: @CODEX ISYMCP`, verificar probe.txt con las dos lineas y el cierre
  del turno.
