# codex-web-http — Arquitectura (M0, 2026-10-06)

Estado: CURRENT medido (no aspiracional). Plan de cierre:
`.opencode/plans/isymcp-final-closure.md`.

## Ruta CURRENT (production)

```
caller (TUI/HTTP)
  → POST /v1/chat/completions            src/server.ts + src/chat-completions.ts
  → session affinity                     src/sessions.ts  (~/.codex-web-http/sessions/default.json → conversationUrl)
  → web adapter                          src/web-turn.ts   (playwright-core + /usr/bin/google-chrome headless,
                                                            storage-state.json, connector CODEX_WEB_HTTP_CONNECTOR)
  → submit + observación DOM             src/web-turn.ts   (busy-wait "Detener", readLastAssistant, extractResponse)
  → tool calls nativos (opcional)        túnel (~/.codex-web-http/bin/tunnel-client)
      → MCP stdio                        src/mcp/main.ts   (session token → bwrap exec/apply_patch/view_image)
  → HTTP body                            src/chat-completions.ts
```

Otras superficies: `/v1/responses` passthrough nativo (`src/passthrough.ts`) y websocket
(`src/ws-responses.ts`); consola operativa `src/isymcp.ts` (up/status/session/tunnel/logs/tui).

## Componentes y claims (precisión obligatoria)

- **Electron: NO participa** en la ruta. No figura en `package.json`
  (`deps: @modelcontextprotocol/sdk, playwright-core`). Las menciones en
  `src/server.ts:7` y `src/web-responses.ts:4` son comentarios históricos.
  Claims separados: *"Electron no se ejecuta"* (DEMONSTRATED operativamente) ≠
  *"Electron no es dependencia de este path"* (DEMONSTRATED por package.json) ≠
  *"browser automation eliminada"* (FALSO: Playwright/Chromium SIGUEN siendo el web adapter).
- **Launcher histórico** (`~/Development/ISyCo Git/codex-chatgpt-web`, Electron): repo
  aparte, `PROVENANCE_ONLY` para este sistema. No revivirlo.
- **Playwright + Chrome headless**: parte interna del adapter web. No confundir con Electron.

## Session tokens (MCP nativo)

- Registro `~/.codex-web-http/codex-sessions.json` (0600), CLI `isymcp session mint|list|revoke`.
- Sandbox: bwrap read-only por defecto; `--write` bindea el workspace; sin bwrap, RO falla cerrado.
- Evidencia: `~/.codex-web-http/mcp-trace.log` (0600; tool + fingerprint + sesión resuelta).

## HISTORICAL (provenance, no operativo)

- Arquitectura MCP+ACK/leases+launcher Electron (ver `docs/TUNNEL_AND_MODELS.md`).
- `nb/` contexto local y `epoch`/`session_ref`: **no integrados** a esta ruta (no asumir).

## Failure evidence

- Fallo de captura → dump automático en `~/.codex-web-http/run/capture-fail-<ts>/` (screenshot + counts).
- Interfaz HTTP: `docs/PROTOCOL.md`. Túnel/modelos: `docs/TUNNEL_AND_MODELS.md`.
