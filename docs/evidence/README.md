# Evidence index — proof of the bridge

Official proof commands:

| Command | What it proves |
|---|---|
| `bun test` | 124/124 — unit, fixtures, integration, security |
| `bun run proof:closure` | tests + one LIVE E2E nonce over HTTP (`HTTP_BODY == NONCE`) + key-file hashes → `closure-<ts>.json` |
| `bun run proof:soak [N]` | N sequential real HTTP turns, unique nonce per turn, plus one idempotent replay per turn → `soak-<ts>.json` |

Soak results kept as evidence:

- `soak-1791327548340.json` — v1 (pre-reviver): 29/100, Chromium page crashed at
  turn 31 and the harness kept going blind. Kept as the incident that justified
  the reviver (M13c).
- `soak-1791333507786.json` — v2 (reviver armed, 69.6 min): **99/100**. The single
  failure was an EXTERNAL OpenAI safety block on one tool call; **0 infrastructure
  failures, 0 empty captures, 0 duplicates, 0 cross-talk**. Every successful turn
  returned its exact nonce and its replay returned `x-isymcp-replayed: 1`.

Other artifacts: `closure-*.json` (reproducible baseline), `capture-fail-*.json`
(sanitized DOM dump from the capture incident — the one that produced the
`extractResponse` fix).
