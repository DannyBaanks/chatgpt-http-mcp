# Codex Web provider: CLI, actual App and separate MCP — 2026-10-10

This report separates a real installed client, a controlled reasoning response,
and a real ChatGPT Web response. A model label or a successful native command
alone does not demonstrate the complete Web conversation.

## Changes

- Linux App launches have independent Codex and desktop homes, copied private
  auth, a selected workspace and the named `isymcp_web` provider. New and resume
  entries preserve the original client. The normal App is not restarted.
- App-generated title turns receive a local label and never bind the launch
  receipt to their auxiliary thread.
- Native result correlation tolerates refreshed descriptive text and additional
  client-declared tools. Existing names, types and schemas remain pinned;
  removal/replacement, wrong call/turn IDs and foreign search outputs reject.
  Persisted registry hashes survive JSON serialization.
- Only the Web provider disables request/stream retries. A known failed local
  round no longer triggers thirty identical requests from Codex.
- The App appends desktop, plugin and MCP tables to its configuration on first
  startup. Resume preserves them, checks the launch-owned prefix and rejects
  edits to that prefix. A real App test found the initial full-file hash check
  too strict; its negative result and the subsequent repair are retained.

## Results

| Claim | Status | Evidence |
|---|---|---|
| Fresh full repository suite | DEMONSTRATED | 496 pass, 1 optional Video Vision skip, 0 fail; 497 tests / 70 files / 2266 expectations |
| Real CLI returns one controlled provider failure without retry flood | DEMONSTRATED | `retry-live`: exit 1, one request, 11.051 s |
| GPT Web requests a command that native CLI executes | DEMONSTRATED, partial loop | `cli1` and `cli4`: native exec exit 0; actual output in subsequent request; earlier registry rejection preserved |
| GPT Web requests a command that actual App executes | DEMONSTRATED, partial loop | `app-live`: native persisted function call and output, exit 0; final Web result was not observed |
| Actual App adapter completes two native command turns, reopening the same thread | DEMONSTRATED with controlled reasoning responses | `app-adapter2`: four adapter rounds, real native outputs in requests 3 and 5, two final messages, one receipt; exact thread deep link between turns |
| Actual App independently obtains its reasoning replies from GPT.com through to a final answer | NOT_DEMONSTRATED | Later attempts blocked by network and reasoning-selector failures |
| Complete real Web-provider CLI call/result/final sequence after fixes | NOT_DEMONSTRATED | Latest fresh attempts did not reach native execution |
| Two real Web conversations can be resumed independently in CLI and App | NOT_DEMONSTRATED | Local state/unit coverage and controlled App test do not substitute for real Web resume |
| New remote Codex ISyMCP tunnel in ChatGPT | DEMONSTRATED | Tunnel `isymcp-native-media` returned `media_list` twice (5 records each); a fresh `codex_turn_start` → inventory (8 executable native tools) → `codex_exec` (`ISYMCP_CONNECTOR_FRESH`, exit 0) → `codex_turn_complete` succeeded |

One earlier full-suite repeat hit an unnamed 10-second lifecycle-hook timeout;
the implicated standalone test passed in 3.46 seconds and the next complete
suite passed in 56.94 seconds. All three outputs remain in the evidence log.

The controlled App canary is the window containing `APP_NATIVE_…` and
`APP_NATIVE_…_SECOND`. Those two responses came from a local test server,
not GPT.com and not the Codex ISyMCP connector. The command execution was real.
The independent historical connector test is recorded in
[the native MCP report](2026-10-10-native-mcp-live.md).

## Negative results and current boundaries

The latest CLI attempts (`cli7`, `cli8`) each sent one request and exited 1.
`cli7` recorded `ERR_NETWORK_CHANGED`; `cli8` reached the page but the owned
reasoning control was unavailable. A read-only selector probe also recorded
`ERR_ADDRESS_UNREACHABLE` and `ERR_ABORTED`. No different model/effort was
silently accepted, no failed submission was called successful and no ambiguous
Web round was automatically resent.

The normal global Codex configuration changed independently during the work.
It is therefore not claimed byte-identical across the whole interval. Isolated
profile tests prove the launcher does not write the native configuration.
No user App process was stopped and no existing user chat or profile was deleted.

A fresh tunnel inspection found the old ID is served by the separate installed
`codex-chatgpt-web` 6.1.7 runtime. The operator created a second tunnel and
requested preserving both. The new runtime initially stopped after control
plane poll timeouts; the first repeated tool call returned `Session terminated`.
After reconnecting the distinct alias, two `media_list` calls and a complete
fresh native token turn succeeded. `healthz`/`readyz` alone were not counted as
proof. The first failed call and restart remain in private raw evidence.

## Final verification

The new alias `isymcp-native-media` now points to the operator-created tunnel;
the 6.1.7 runtime keeps its original alias and ID. The repository connector
metadata is scoped to the new alias. Automated tests verify an attachment uses
the runtime key reference without an admin organization file, and refuses a
shared/foreign tunnel before writing a launcher or replacing metadata.
The original metadata was preserved in the private evidence folder for
recovery. Full suite totals appear in the adjacent evidence transcript.

## Evidence

Raw requests, screenshots, rollouts and receipts remain private. The
[SHA-256 manifest](../evidence/web-provider-20261010-manifest.json) contains
exact paths, sizes and hashes; credentials and session-token records are excluded.
The combined [suite output](../evidence/web-provider-20261010-tests.txt) has
SHA-256 `9437cbd95c3b0e468849100df0d4b79ee682b1d3d595ac01bf2efe5edb32a409`.
The successful [remote MCP canary](../evidence/web-provider-20261010-connector-canary.json)
records its results without storing the session token.

Host: Ubuntu 24.04, Bun 1.4.2, Codex CLI 0.162.x and installed desktop App
26.930.51102 (bundled native Codex 0.160.0). App tests used their own profiles
and workspace. Production `isymcp conversation new/resume` commands and
real Web final-answer/resume gates remain explicitly unclosed.
