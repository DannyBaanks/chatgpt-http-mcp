# Codex ISyMCP in a real Chrome conversation — 2026-10-12

Three actual ChatGPT website turns completed using the existing **Codex
ISyMCP** connector. This is evidence for the standalone MCP conversation path;
it is not proof of the planned active Codex CLI/App executor integration.

The operator selected the real mention and verified its rendered
`app-mention-path` against `app://asdk_app_6acab55999f4819194e050ed413a8dab`
before submission. The account's rendered selector was recorded with **GPT-6**
checked and **Medium** effort after the user authorized the available ChatGPT
model. An earlier transient selector showed GPT-5.6 Sol; this run is not labelled
as a GPT-5.6 test.

| Step | Observed result | Scope of evidence |
| --- | --- | --- |
| 1 — `media_list` | GPT returned five registered media and reported no version field | Actual completed website answer and visible tool activity; tunnel dispatcher forwarded the request. The exact response payload is not in the native coding trace. |
| 2 — start, inventory, exec, complete | The server recorded all four calls; one `codex_exec`, exit 0, 17 ms. GPT returned the unique marker and identified `bwrap-read-only`. | Independent server trace plus actual rendered final answer. Workspace capability was read-only and scoped to a new empty scratch directory. |
| 3 — context recall | GPT recalled the count, exact marker and sandbox without another requested tool call | Actual third answer in the same conversation; the coding trace retained one execution. |
| Browser reload | All three replies and the same conversation URL returned; coding call/result count remained one | New browser snapshot plus equal before/after coding traces. This proves browser conversation retention, not native Codex thread resumption. |

Marker: `ISYMCP_CHROME_10eb17b364b4400e9bff522816bbebf3`.
The thirty-minute test capability was revoked after completion. No other
session or tunnel was revoked. Global `~/.codex/config.toml` remained unchanged,
SHA-256 `c2ae08740df53819e9765f0a74d3d6b60705438b25379fb3eb2b73ca99f1aa75`;
it has no global `openai_base_url`.

## Browser message identity finding

The live page exposed UUID user message keys in `data-turn-key` and assistant
IDs in `data-dil-message-id` / `data-dil-source-message-id`. The second and third
user keys, and their assistant IDs, survived a real reload. The first user
temporarily appeared under `fallback-turn-0` before its UUID became visible
after reload. `data-content-search-turn-key` remained index-based fallback data.
Those fallback values must not be used as logical message identities.

This establishes rendered source-identity feasibility. It does not implement
the observer or bind those IDs to a native Codex owner. The initial narrow
search for old `data-message-id` attributes found none; that negative
observation and the later actual attributes are both preserved.

## Evidence

Private directory:
`.superpowers/sdd/2026-10-11-visible-chrome-native-mcp/chrome-isymcp-conversation-20261012-01/`.
It contains the actual conversation URL, rendered snapshots, message-ID
bindings, model selector, server trace, screenshots and a SHA-256 manifest.
Tokens and private browser context are excluded from this public report.

- Coding trace before and after reload:
  `8eb5684d7585bca231e33ffb0fb27dd4defd374ba38d0cb4f184fbf258924da9`.
- Completed redacted DOM snapshot:
  `835ccb52237fc37c0aeb4be4477b21d14c785534ebcdabc736e51a2b34a70788`.
- Post-reload private snapshot:
  `458ce0db3f490ad83c9dcaf573075be9c544cfcda071bda8ae297bac0ee36734`.
- Model selector:
  `e3dd0d9b4dd2ae0c3659cab4ecf7e4854dcc4818e296b0876a9c1ea08b522a3f`.
- Scoped standalone-web receipt:
  `b68e3312d40da5034d6ecbb74bdc9a217dc223b3d01d2e9a071acee5c55589b4`.

## Remaining boundary

The backend reported `codex-web-http sessions` with `bwrap-read-only`. The
coding trace has `turn_id:null`: this is not an active Codex-native task. Native2
is a distinct reference connector and still returned a separate remote session
error. Automatic Chrome launch/binding from a Codex client, native tool ownership
through this ISyMCP connector, native cancellation/resumption, and progressive
mirroring into Codex CLI/App remain **NOT_DEMONSTRATED**. M0 stays open, and no
M1–M5 completion claim is made.
