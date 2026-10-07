# chatgpt-http-mcp

**Turn ChatGPT Web into an HTTP API you control — with native tool execution on your machine.**

No API key. No Electron. A small local bridge that drives a real ChatGPT Web
conversation (headless Chrome), captures the answer from the DOM, and returns it
over an OpenAI-compatible HTTP endpoint. Native tool calls travel back through an
outbound tunnel to a local MCP server that executes under sandbox policy.

```
caller (any OpenAI-compatible client)
  └─ POST /v1/chat/completions
        └─ bridge (Bun)  ── session affinity (~/.codex-web-http/sessions)
              └─ headless Chrome + Playwright ── ChatGPT Web turn
                    └─ DOM capture (semantic selector → extractResponse → anti-echo)
              └─ native tool calls: tunnel → MCP stdio → bubblewrap sandbox
  └─ HTTP response
```

## Features

- **HTTP surface**: `POST /v1/chat/completions` (web models `chatgpt-web/*`),
  native passthrough for `/v1/responses`, `/v1/models`, websocket.
- **Native tools** (`Codex ISyMCP` connector): `codex_exec`, `codex_apply_patch`,
  `codex_view_image`, `codex_tool_inventory`, turn lifecycle — executed locally.
- **Session tokens**: `isymcp session mint|list|revoke` — capability tokens bound
  to a workspace; read-only by default (`--write` to allow patches).
- **Sandbox**: bubblewrap. Read-only root by default; `--write` sessions bind only
  their workspace. Without bwrap, read-only sessions fail closed.
- **Idempotency**: `x-isymcp-turn-id` header — replays return the same response
  (`x-isymcp-replayed: 1`) without re-executing the model.
- **Honest errors**: typed taxonomy mapped to HTTP status (400/401/409/502/503/504).
- **Robust capture**: semantic selector chain, anti-echo, busy-wait, sanitized
  failure dumps (`~/.codex-web-http/run/capture-fail-*`).
- **Reviver**: detects Chromium page crashes, relaunches and re-captures the
  already-generated answer — it never re-sends a turn.
- **Visual panel**: `isymcp panel` → http://127.0.0.1:8798 (status + actions).

## Quickstart

```bash
bun install

# 1. Import your ChatGPT session cookies (one time)
bun run scripts/import-cookies.ts

# 2. Bring everything up (server + tunnel + connector)
isymcp up

# 3. Or wire it into your TUI (opencode/OpenISy)
isymcp tui install --apply
```

```bash
curl -s http://127.0.0.1:8791/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/gpt-5.6-sol","messages":[{"role":"user","content":"hola"}]}'
```

## Operations

| Command | What |
|---|---|
| `isymcp up / down / status` | server + tunnel lifecycle, honest status |
| `isymcp panel` | visual control panel (:8798) |
| `isymcp session mint --cwd <dir> [--write]` | issue a session token |
| `isymcp session list / revoke <token\|fp>` | audit / revoke |
| `isymcp tunnel connect / stop / status` | MCP tunnel |
| `isymcp logs` | bridge logs |

## Evidence

- `bun test` → **124/124**.
- Soak: **100 sequential real HTTP turns** (unique nonce per turn + idempotent
  replay check): **99 exact, 0 infrastructure failures, 0 empty captures,
  0 duplicates, 0 cross-talk**. The single failure was an *external* OpenAI
  safety block on one tool call — the bridge kept working, which is exactly what
  the soak was meant to prove.
- Failure dumps are sanitized; MCP traces store token fingerprints only.

## Docs

`docs/ARCHITECTURE.md` · `docs/PROTOCOL.md` · `docs/TUNNEL_AND_MODELS.md` ·
`docs/LIFECYCLE.md` · `docs/LEGACY.md` · `docs/EVIDENCE.md`

## Security notes

- Secrets live outside the repo: `~/.codex-web-http/` (0600).
- Session tokens are shown once; every artifact stores fingerprints (`sha256[:12]`).
- The panel binds 127.0.0.1 only.
- `URL != authority`: conversation URLs and local files never grant execution.

## License

MIT — see `LICENSE`. Derivative mechanics from MIT projects are credited in
`NOTICE`.
