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
  Ver `docs/EVIDENCE.md`.
- M1 (gate HTTP Web) / M3 (catalogo) / M4 (transporte): pendientes segun
  plan; M1 requiere un login humano unico.
