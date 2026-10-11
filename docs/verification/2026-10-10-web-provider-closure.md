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
| Fresh full repository suite | DEMONSTRATED | Latest run: 498 pass, 1 optional Video Vision skip, 0 fail; 499 tests / 70 files |
| Real CLI returns one controlled provider failure without retry flood | DEMONSTRATED | `retry-live`: exit 1, one request, 11.051 s |
| GPT Web requests a command that native CLI executes | DEMONSTRATED, partial loop | `cli1` and `cli4`: native exec exit 0; actual output in subsequent request; earlier registry rejection preserved |
| GPT Web requests a command that actual App executes | DEMONSTRATED, partial loop | `app-live`: native persisted function call and output, exit 0; final Web result was not observed |
| Actual App adapter completes two native command turns, reopening the same thread | DEMONSTRATED with controlled reasoning responses | `app-adapter2`: four adapter rounds, real native outputs in requests 3 and 5, two final messages, one receipt; exact thread deep link between turns |
| Actual App independently obtains its reasoning replies from GPT.com through to a final answer | NOT_DEMONSTRATED | Later attempts blocked by network and reasoning-selector failures |
| Real GPT-5.6 Web final answer in a new isolated CLI conversation | DEMONSTRATED | After selector compatibility fix, fresh CLI canary returned `CLI_WEB_FINAL_OK`; private receipt committed against `chatgpt.com`, task state ended with assistant final and no pending call |
| Real GPT-5.6 Web resume in the same CLI conversation | DEMONSTRATED | `isymcp conversation resume` reopened the saved thread; second canary returned `CLI_WEB_RESUME_OK`, with no pending call |
| Real Web final answer in the isolated Codex App | DEMONSTRATED | Fresh App canary returned exact marker `APP_WEB_FINAL_OK`; the committed private receipt and same-profile thread history agree |
| Real Web resume in the same isolated Codex App conversation | DEMONSTRATED | The same App thread returned `APP_WEB_RESUME_OK`; local history shows completed final and resume turns, with no pending task |
| Two real Web conversations can be resumed independently in CLI and App | DEMONSTRATED | CLI new + resume and isolated App new + same-thread resume each returned their exact final markers |
| New remote Codex ISyMCP tunnel in ChatGPT | DEMONSTRATED | Tunnel `isymcp-native-media` returned `media_list` twice (5 records each); a fresh `codex_turn_start` → inventory (8 executable native tools) → `codex_exec` (`ISYMCP_CONNECTOR_FRESH`, exit 0) → `codex_turn_complete` succeeded |

One earlier full-suite repeat hit an unnamed 10-second lifecycle-hook timeout;
the implicated standalone test passed in 3.46 seconds and the next complete
suite passed in 56.94 seconds. All three outputs remain in the evidence log.

The controlled App canary is the window containing `APP_NATIVE_…` and
`APP_NATIVE_…_SECOND`. Those two responses came from a local test server,
not GPT.com and not the Codex ISyMCP connector. The command execution was real.
The independent historical connector test is recorded in
[the native MCP report](2026-10-10-native-mcp-live.md).

## 2026-10-11 App canary: negative result and follow-up

The dedicated GPT-5.6 Sol / High App test submitted the exact-output prompt
`Responde exactamente APP_WEB_FINAL_OK y nada más`. The bridge captured a
non-empty Web response in a canonical ChatGPT conversation, but that response
was not one JSON object accepted by the native Responses transport. It returned
`502 web_tool_protocol_invalid`. A second submission was correctly rejected
with `409 web_task_pending`: the first submit may already have completed on
ChatGPT, so replaying it could duplicate user work. The durable task record has
a pending turn and conversation URL; the turn record is `attempted`, without a
committed response. We did not clear or retry that state.

The request builder previously placed the transport contract before the user
prompt inside one Web message; that ordering has since been corrected. A new
isolated App launch then showed the same exact-output prompt failing in two
different stages: the first request failed before submission with
`web_turn_not_submitted`, while a manual retry reached a Web response but was
rejected with `web_tool_protocol_invalid`. This narrows the cause to the
adapter's strict JSON-only reply parser. The raw reply is not retained, so its
exact text remains unknown. The parser now accepts ordinary non-JSON text as a
final answer, while malformed structured replies still fail and only valid,
schema-checked JSON can request a native tool. Regression tests cover the exact
marker and malformed-envelope cases. The subsequent fresh App final and the
remaining same-thread resume gate are recorded below.

### Fresh App final-answer canary and same-thread resume

A fresh isolated App profile then submitted the exact prompt again. The first
attempt failed before completion; the retry returned exactly
`APP_WEB_FINAL_OK`. The committed private receipt identifies client `app`,
model `chatgpt-web/gpt-5.6-sol`, effort `high`, and a test workspace. The
profile's local Codex thread history contains the exact assistant final and
shows a completed turn; the durable bridge task is no longer pending and its
conversation URL matches the committed receipt. The earlier failed attempt is
still retained as a failure. This demonstrates a real GPT-5.6 Web final answer
through the isolated Codex App provider path, not native MCP tool execution.

The user then sent `Responde exactamente APP_WEB_RESUME_OK y nada más` in that
same isolated App conversation. It returned exactly `APP_WEB_RESUME_OK`. The
same-profile thread database shows the prompt and answer in the existing thread;
turns are recorded as one retained failure followed by two completed turns.
The committed conversation receipt remains bound to the same private URL, and
the durable task has no pending turn with `APP_WEB_RESUME_OK` as its final text.
This closes the App final/resume gate. The response appeared rapidly in the
user-provided screenshot, but no stopwatch measurement was captured. A
sanitized [App canary transcript](../evidence/web-provider-20261011-app-live.txt)
records these observations without publishing thread identifiers or URLs.

## Negative results and current boundaries

The earlier CLI attempts (`cli7`, `cli8`) each sent one request and exited 1.
`cli7` recorded `ERR_NETWORK_CHANGED`; `cli8` reached the page but the owned
reasoning control was unavailable. A read-only selector probe also recorded
`ERR_ADDRESS_UNREACHABLE` and `ERR_ABORTED`. A later real attempt isolated the
remaining selector mismatch: this ChatGPT UI labels maximum effort as `5.6 High`
for GPT-5.6. The validator now accepts a version-prefixed High label only when
it matches the selected model, while still requiring the maximum 3/3 slider
position. New and resumed live CLI canaries then completed with exact final
markers. The initial failed submissions remain historical failures; they were
not retried automatically or relabeled as successes.

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
The latest full [suite transcript](../evidence/web-provider-20261011-tests.txt)
records 498 pass, 1 skip, 0 fail and has SHA-256
`ed8893a30bb02a7cb080e9ebbcee44b64f8f7ba513df57360cf6768bd2a7f318`.
The sanitized [live CLI canary](../evidence/web-provider-20261011-cli-live.txt)
records new + resume results and private-state digests without exposing the
conversation URL or identifiers; SHA-256
`af126f482a6526fab0e4af94aede3674e8e846a9ed8d761e4b068c47eae126b0`.
The sanitized [live App canary](../evidence/web-provider-20261011-app-live.txt)
records final + same-thread resume results without exposing the conversation
URL, thread identifier, or receipt; SHA-256
`6f746109763b40fccf931bc1ec67eab101d570e529c71c681f24208b38a0d7df`.
The successful [remote MCP canary](../evidence/web-provider-20261010-connector-canary.json)
records its results without storing the session token.

Host: Ubuntu 24.04, Bun 1.4.2, Codex CLI 0.162.x and installed desktop App
26.930.51102 (bundled native Codex 0.160.0). The live CLI new/resume tests used
an isolated temporary workspace and the dedicated Web bridge; their committed
conversation receipt and task state were checked without publishing the private
thread URL or identifiers. App tests used their own profile and workspace.
Production CLI and isolated App final/resume are demonstrated independently;
the initial App failures remain preserved as failures and are not relabeled.
