# Real ISyMCP → active native Desktop App — 2026-10-13

## Demonstrated operation

Authenticated Chrome ChatGPT invoked the newly installed Codex ISyMCP App `asdk_app_6ace90ad54848191912160b8880294c7`, using the existing tunnel `tunnel_6acaaf6bbfb88191a9f8a2ecb291e46a`. A locally verified source message was bound to the active Desktop App turn. The actual App executed one foreground read-only `printf`, returned the correlated native result, then received the real MCP completion summary and recorded task completion in its rollout.

- Chrome conversation: https://chatgpt.com/c/6ace8d1f-4448-83e8-a2bc-40f1dd92415a
- Source message UUID: `451d9bda-c079-4842-a23b-255feb1a57ab`
- Desktop App writer: `Codex Desktop`, version `0.160.0`.
- Thread: `01a12f10-6159-7791-b7fb-9744b683a7c8`.
- Turn: `01a136f2-f8b1-7e23-bd79-007654c0f91c`.
- Native call/result ID: `call_4--kOlmtFGT8KCXaZEtvhdgX82MoxveI`.
- Marker: `ISYMCP_APP_NATIVE_1ba90c3ad2b047c3a6f9a47a75b68b15`, exit code **0**.
- Four actual remote entries: `codex_turn_start`, `codex_tool_inventory`, one `codex_exec`, `codex_turn_complete`. Two native provider requests. No local replacement executor.

The completion was independently checked in the actual App rollout: matching custom tool output and task-complete event containing the marker. Controller exited 0, receiver closed and capability revoked. The isolated profile config remained pinned to SHA-256 `8a70df2a4ca89f35e04ed76a62d20b55c2674604014930ae9d8d097877503b2e`. No auth copying or global provider edits. This does not claim the user's global config stayed byte-identical throughout unrelated work.

## Controls and failures preserved

Previous App attempts failed because of formatted-marker rejection, disconnected response streams, or remote `Session terminated` before tool execution. They remain preserved in separate private evidence directories; none was relabelled as a pass. The live rejected body contained the whole marker wrapped in bold Markdown. Regression now accepts only plain, whole inline-code, or whole bold marker; extra text rejects. Focused App/active-native suite: 14 pass, zero failures; raw hash in transport-lifetime report. Earlier full suite: 516 pass, one skip, zero failures before the final bold-marker change; no newer full-suite claim.

Reconnecting the old App installation did not restore calls. The user recreated the installation with the same tunnel, producing the new App ID and icon. Real `media_list` succeeded under that new ID before the native canary. ChatGPT asked to approve printing an opaque nonce; only that read-only command was allowed once, without persistent permission expansion.

## Scope / NOT_DEMONSTRATED

The native CLI and Desktop App now each have an independent live foreground read-only exec canary. This is not a completed general conversational provider: the App window uses a narrow probe endpoint and needs the locally coordinated Chrome callback. Broad coding tools, patch writes, background stdin, native image/audio transport, unattended startup/source binding, continuous reasoning streaming, and App cancellation/resumption remain NOT_DEMONSTRATED. M0 remains OPEN for its remaining matrix/lifecycle requirements; M1–M5 are not certified. Author-only review follows the user's solo-work instruction.

## Raw evidence

Private directory: `/home/danny/.codex-web-http/canaries/active-app-20261013-bold-fixed-01`. Original hashes independently verified; additional browser/scoped-trace hashes are in a separate `verified-hashes.json`. Tokens remain private and revoked, not published here.

- `status.json`: `2de3afca7298171c92e18310f4112e62774d2fbf4c99c31fb93d62f1c8d1c8c8`
- `profile-before.json`: `ac8c4a47e5b8d6a1eb0c76b8ea93b38eb4ff2484409e15abd5f109606549ec11`
- `native-call.json`: `f660c440ed33c9abe94b64bf621acc0be1d5b39db69654357943455ca768160d`
- `native-result.json`: `89a825dc656a9da1a0bd0a1cb5751d27efe327f2ecaffd290a63451b86470157`
- `native-rollout-scoped.json`: `c7c30ca08f77977173eef194711bc8d5fb1676c4dc69ccf8bf375a4b5af19be4`
- `receipt.json`: `76320dc3c3525715085cbe4a439eba0333d2c2ae0ee2abead6a3fd230c3d8e1c`
- `mcp-completion-summary.json`: `6985d45544afb059ead240dfa86b22890eb94fa20c7da2fd3545dea028f1d4b2`
- `browser-success.png`: `8d13c889da5d0e61d19d36bd023c4546dffff95a154fcea4352ae123d5d937b4`
- `browser-binding.json`: `722b88ca393a768b43ad3c07f1ea52d44f0f454b5eb16a0ab2a02b743efa3de1`
- `mcp-trace-scoped.txt`: `c7de247d7b12ce3b25755d33844c2ad087af7efb8519a58c4701d5fdca4ecd8d`
