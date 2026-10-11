# Visible Chrome native host contract — 2026-10-11

## Result

**M0 remains open.** One live canary demonstrates a native coding-tool round trip through the installed Codex CLI app-server with a disposable local Responses provider. A separate ChatGPT.com canary completed the installed connector's `start → inventory → complete` cycle, but its receipt identifies the local `codex-web-http` session sandbox (`bwrap`), not an active native Codex host. The four client/origin combinations and desktop App ownership are not closed.

## Demonstrated: installed Codex CLI app-server

- Codex CLI: `codex-cli 0.162.0`; Bun: `1.4.2`; Node: `v24.21.0`.
- Probe command: `bun run scripts/probe-visible-host.ts --client cli --entry codex --evidence-dir /tmp/isymcp-visible-cli-attempt7`.
- The probe initialized the installed `codex app-server --listen stdio://`, started an ephemeral thread and turn, and used a disposable local deterministic Responses endpoint. It did not change global Codex settings or use the user's authenticated session.
- The provider requested native function `exec_command` with a unique `printf` canary. The real app-server emitted a `commandExecution` item, completed it with exit code `0`, and returned the canary on stdout. Its next `/v1/responses` request contained `function_call_output` with the same `call_id` and matching stdout. The turn then completed; the process exited `0` after two Responses requests.
- The installed wire name observed by this host is `exec_command`. The earlier candidate `functions.exec_command` is not the native wire name for this app-server interface.
- Focused unit tests: `bun test tests/visible-host.test.ts` → 3 passed, 0 failed.
- Post-change full suite: `bun test` → 503 passed, 1 skipped, 0 failed across 504 tests in 71 files; raw output `.superpowers/sdd/2026-10-11-visible-chrome-native-mcp/task1-full-suite.txt`, SHA-256 `eef72022011f68a60d8f18bcbad335660dd65174f74c3766146c21049ff695be`.
- Pre-change baseline: 500 passed, 1 skipped, 0 failed across 501 tests; raw output is preserved at `.superpowers/sdd/2026-10-11-visible-chrome-native-mcp/baseline-tests.txt` (SHA-256 `3b9322c64f3782cd4dc87369429cdf687c915c3588ad067da40a11303f34207c`). This baseline predates the current changes and is not a post-change full-suite result.
- Raw, permission-restricted receipt: `.superpowers/sdd/2026-10-11-visible-chrome-native-mcp/probe-cli-codex-live-roundtrip-20261011/receipt.json`; SHA-256 `ec473a225685883d05ccfb0e35000495f8f66572218d7a780f0b544f8fa3915c`.

## Demonstrated: ChatGPT.com connector lifecycle (installed MCP, not native host)

- The logged-in ChatGPT.com UI listed **Codex ISyMCP** as installed and
  connected. A new test conversation was opened through its “Probar en el
  chat” action; no pre-existing conversation was modified.
- The first inventory request omitted `turn_token` and was rejected by the
  connector schema (`'turn_token' is a required property`). No server tool
  executed. This confirms `codex_turn_start` does not mint its own capability.
- `isymcp up` started the installed bridge and its configured separate tunnel;
  `isymcp status` then reported server/MCP up and tunnel ready. The live MCP
  command was `/home/danny/.codex-web-http/bin/isymcp-mcp`, not code from this
  development worktree.
- A read-only token was minted for `/tmp` with a six-minute TTL and fingerprint
  `3c3742fe4665`; it was revoked after the test (`Revoked sessions: 1`). The
  token value is not retained in this report or evidence.
- ChatGPT.com called `codex_turn_start`, `codex_tool_inventory`, and
  `codex_turn_complete` successfully. The inventory returned eight executable
  tool names: `codex_turn_start`, `codex_exec`, `codex_write_stdin`,
  `codex_apply_patch`, `codex_view_image`, `codex_tool_inventory`,
  `codex_tool_call`, and `codex_turn_complete`. The returned source was
  `codex-web-http sessions`; the sandbox was `bwrap`. No `codex_exec`, patch,
  or write tool was called. Completion reported `live_execs_killed: 0`.
- This is a successful ChatGPT.com-to-installed-MCP lifecycle test. It is
  **not** evidence that a tool ran inside the active Codex CLI/App host. The
  visible browser message ID and connector `_meta`/`requestInfo` fields were
  not exposed to the MCP response.
- A separate read-only `Codex Native2` inventory probe was rejected once by
  its argument validator (`limit` maximum 50); the corrected request then
  failed before inventory with `McpServerError: MCP SSE probe returned 404
  from openai.org`. No native tool ran in that probe.
- After that canary, a local `isymcp status` check found the bridge stopped and
  the tunnel not ready. `isymcp up` restarted the separate runtime (server PID
  `53474`); the subsequent status reported server/MCP up and tunnel
  `ready=true`. This recovery does not change the canary's executor identity.
- Private receipt, with the token omitted and connector URL redacted:
  `.superpowers/sdd/2026-10-11-visible-chrome-native-mcp/chatgpt-origin-canary.json`.
  SHA-256 `7119a16c3acc8731faf26da173bfd35b5aa40a1c551f4c62c364801c7b08f2c7`.

## NOT_DEMONSTRATED

- **ChatGPT browser source metadata and native-host dispatch:** an authenticated connector lifecycle now works with a pre-minted token, but the server reports `codex-web-http sessions` and `bwrap`; no verified browser message identity or active native-host dispatch was demonstrated.
- **Desktop Codex App ownership:** no live desktop App canary was run. The standalone CLI app-server result is not evidence of Electron App turn ownership; the separate Native2 inventory attempt returned a tunnel 404 before calling a host tool.
- **Cancellation and exact resume:** not exercised in this canary.
- **CLI/App × Codex/ChatGPT matrix:** only `cli/codex` has one demonstrated tool round trip. The other three combinations remain untested.
- **M1 and later:** not started. Per the approved milestone gate, fixture tests and a CLI app-server canary cannot substitute for the M0 browser-origin and desktop ownership probes.

The raw probe also recorded an unrelated `office-bridge` MCP startup warning. This probe did not call that MCP server; its warning does not change the canary result or prove general MCP availability.

## Scope of the implementation so far

Task 1 adds shared visible-host contracts, a process-local exclusive-writer guard, strict browser-source binding validation, native call/result correlation, a disposable CLI probe, and focused tests. `inspectHost` stays conservative and does not mark a host supported based solely on detecting an installed binary. The live check started the installed bridge and separate tunnel, created and then revoked one read-only token, and opened a new test ChatGPT conversation; no existing chat or credential was changed. The bridge/tunnel were subsequently found stopped and restarted with `isymcp up`; current `isymcp status` reports server/MCP up and tunnel ready. No global Codex model/base-URL configuration command was run.

**Next gate:** obtain the authenticated browser source metadata for the bound message; separately establish a live desktop App ownership canary. Then exercise cancellation/resume and the remaining origin/client checks. Until these are captured, M0 stays open and the feature is not ready for M1.
