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
  to a workspace; read-only by default (`--write` to allow patches); expire after
  7 days (`--ttl <hours>`, `--ttl 0` = never).
- **Sandbox**: bubblewrap. `$HOME` and the bridge home (tokens, cookies) are
  hidden behind tmpfs, no network, minimal env; only the session workspace is
  exposed (read-only, or read-write with `--write`). Toolchains under `$HOME`
  (`~/.bun`, `~/.local/bin`, `~/.cargo/bin`, …) come back read-only. Without
  bwrap every session fails closed.
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
bun link            # puts `isymcp` on your PATH (or: alias isymcp="bun run $PWD/src/isymcp.ts")

# 1. Import your ChatGPT session cookies (one time; keep the file chmod 600)
bun run scripts/import-cookies.ts --file /path/to/cookie.txt

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

## Local chat UI

`isymcp panel` → http://127.0.0.1:8798 opens on the **Chat** tab (the old
dashboard lives under **Estado**).

- Every chat in the sidebar is its **own real ChatGPT conversation** (`/c/`).
  The first message opens a new conversation and its canonical URL is captured
  and stored in `~/.codex-web-http/chats/<id>.json` (dir 0700, files 0600).
- Only the **new** message is sent each turn (ChatGPT already holds the
  context). `/v1/chat/completions` keeps its contract (full transcript).
- **Live text**: the answer appears while ChatGPT is writing (the bridge
  re-reads the DOM every ~0.4 s; each update replaces the whole partial).
- Lists, code blocks, links: rebuilt as Markdown from ChatGPT's DOM and
  rendered by an escape-first renderer — model HTML never reaches the page.
- The browser only ever sends `chat_id` + text. The bridge resolves the `/c/`;
  no tokens, cookies or storage-state go to the page.
- Errors say who failed: OpenAI blocked it / ChatGPT session / Chrome / bridge.
- **Tools (Phase 2)**: off in every new chat. Turn on *Codex ISyMCP* per chat
  and pick one of your sessions (`isymcp session mint …`); the page shows fp,
  folder, ro/rw and expiry — never the token. Each turn mints an **ephemeral
  turn token** (inherits the session's folder/mode, 15 min, revoked when the
  turn ends, dies with its session): only that goes to chatgpt.com. Tool cards
  (`codex_exec · git status · exit 0 · 420 ms`) come from `mcp-trace.log`
  filtered by that turn's token fingerprint — evidence, not the model's word —
  and appear live. The trace never stores stdout.
- **ChatGPT settings (model / reasoning)**: the web transport does not pick a
  model — it uses whatever the headless ChatGPT shows. *Verificar* reads it
  (read-only; e.g. `GPT-5.6 Sol · Instant (1/3)`). *Sincronizar ajustes* pauses
  turns, opens a **visible** Chrome with your session, you set things by hand
  and close it; the new storage-state (with IndexedDB) is saved only if still
  logged in, with a 0600 backup of the previous one (last 5 kept).

Checks: `bun run scripts/e2e-chat-tools.ts` (real tools: read + write, cards from the trace, 0 turn tokens left) · `bun run scripts/e2e-two-chats.ts` (real, two chats, distinct `/c/`,
independent context) · `bun run scripts/panel-layout-check.ts` (no horizontal
overflow at 1400/390 px, no injected HTML).

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

- `bun test` → **180/180** (incl. live sandbox-isolation and CSRF/DNS-rebinding
  regressions).
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
  The token travels in the ChatGPT message text, so it ends up in your OpenAI
  history: that is why tokens expire. Revoke with `isymcp session revoke <fp>`.
- Bridge (:8791) and panel (:8798) bind 127.0.0.1 **and** reject foreign `Host`
  / `Origin` headers and non-JSON POSTs, so a web page you visit cannot drive
  them (CSRF), read them (DNS rebinding) or open the websocket.
  Extra hostnames: `CODEX_WEB_HTTP_ALLOWED_HOSTS=a,b`.
- Do not mint a session whose workspace contains secrets (e.g. all of `~`):
  the workspace is exactly what the model can read.
- `URL != authority`: conversation URLs and local files never grant execution.

### Knobs

| Env | Default | What |
|---|---|---|
| `CODEX_WEB_HTTP_CHROME` | `/usr/bin/google-chrome` | Chrome binary |
| `CODEX_WEB_HTTP_SANDBOX_NET` | off | `1` gives sandboxed commands network |
| `CODEX_WEB_HTTP_SANDBOX_ENV` | — | extra env vars passed into the sandbox |
| `CODEX_WEB_HTTP_SANDBOX_RO_BINDS` | — | extra read-only paths (relative to `$HOME` or absolute) |
| `CODEX_WEB_HTTP_SANDBOX=off` | — | operator opt-out: only `--write` sessions run, unconfined |

## License

MIT — see `LICENSE`. Derivative mechanics from MIT projects are credited in
`NOTICE`.
