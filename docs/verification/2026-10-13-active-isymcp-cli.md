# Real Codex ISyMCP → active native CLI — 2026-10-13

## Outcome

**DEMONSTRATED:** actual ChatGPT in visible Chrome invoked our Codex ISyMCP
connector; its `codex_exec` was forwarded to one owned, active installed Codex
CLI thread/turn. The installed CLI executed the command, returned a matching
custom output, and the original MCP call returned that actual output and exit
code 0. ChatGPT called `codex_turn_complete`; its actual completion summary
returned to the same native controller, which completed the native turn.

This uses the connector `asdk_app_6acab55999f4819194e050ed413a8dab` and tunnel
`tunnel_6acaaf6bbfb88191a9f8a2ecb291e46a`. It does not invoke Native2, run the
command in the MCP process, or ask the model to print a JSON tool envelope.
The Chrome selector showed GPT-6 / Medium; do not label this GPT-5.6 Sol.

## Actual ownership and source

| Field | Observed value |
| --- | --- |
| Executor | installed Codex CLI 0.162.0, native app-server |
| Backend | `active-codex` |
| Native thread | `01a134c8-5df3-74e0-b78c-5ba6c3cfc0a7` |
| Native turn | `01a134c8-5dff-71b1-aa5e-912a04e38785` |
| Native call ID | `call_IqSoVORrtymzzWrQt0-1Pc3dRlEyEqPu` |
| Capability fingerprint | `c71a2274daf8`, revoked after completion |
| Browser conversation | `https://chatgpt.com/c/6acd9936-1fb8-83e8-a071-8795f0271dd1` |
| Actual rendered user message UUID | `357da3b8-4421-4210-8af7-590e26720119` |
| Native provider requests | two, with resubmission disabled |
| Command | argv `printf`, `%s\n`, `ISYMCP_ACTIVE_NATIVE_38cab95ba1f94946ad7d82072385c2df` |
| Actual command output | same unique marker, newline, exit 0 |

Started 2026-10-13T10:21:48.765Z; native turn completed at
2026-10-13T10:23:35.154Z. The four actual remote MCP results are independently
recorded in `mcp-trace.log` with the same fingerprint, native thread and turn.
Only one `codex_exec` is recorded. The native custom call/output IDs match;
the original native result contains the marker and exit code, not a model's
claim of execution. No file was written in the canary workspace.

The local operator bound the newly rendered browser message UUID after one
submission. This is **manual source binding**, not an implemented automatic
browser observer. The controller enforces the exact canary gateway/argv and
its native request thread. It is a narrow probe, not a general conversation
provider. Its final native text is the actual MCP completion summary; equality
with the later, separately written browser final is not claimed.

## Implementation and failure behavior

`src/mcp/active-native.ts` selects only an explicit native owner stored in a
private session record. No model, port or token-prefix inference selects an
executor. The private broker socket identity is pinned; expiry, completion,
unbound source, unavailable owner, unsupported tools and changed call IDs fail
closed. Every coding entry checks this route before its standalone handler.
There is no bwrap fallback. Media remains token-free and independently routed.

`src/mcp/active-broker.ts` queues native calls and resolves them only from their
matching native output. It contains no tool executor. Each binding belongs to
one activity; a completed activity cannot borrow another activity's authority.
A completion fence rejects pending calls or a changed revision. The probe
owns its private broker, installed CLI child, workspace and Codex home; it does
not start or edit the Native2 daemon, tunnel or configuration.

The first adapter supports five entries: start, inventory, foreground read-only
exec, tool_call to exec/inventory, and complete. Patch, image, background and
stdin are explicitly unsupported for native tokens. Inventory reports those
limits; standalone sandbox sessions retain their previous functionality.
Native `output` is combined command output, without fabricated stdout/stderr.
Durable per-turn journals reserve calls before delivery, replay completed
results, reject changed arguments for an explicit ID, and refuse resubmission
of pending/uncertain operations. Identical direct argv/cwd calls replay once
per native turn; an explicit tool_call ID distinguishes intentional operations.

The first real browser attempt arrived before local source binding. Start
returned `native_source_not_bound`; GPT stopped and no command was delivered.
That failed evidence is retained. After adding a bounded thirty-second wait
to bootstrap only, a fresh native turn and capability passed. Execution remains
blocked while prepared. The successful run was submitted once, not a resend of
an ambiguous command. No unrelated native client or task was closed.

## Verification and evidence

The new test file first failed with the missing adapter module. Subsequent
tests cover prepared state, bootstrap binding, real Unix IPC queue/results,
stale bindings, completion fences, persistent replay, changed IDs, expiry,
unsupported modes, private inventory and all eight real MCP stdio entries with
an unavailable native owner. The negative stdio test verifies that no local
fallback file was created and that media_list still works.

Final command `bun test` after owner/binding review: **508 pass, 1 skip,
0 fail**, 2337 assertions across 72 files, exit 0. The omitted case requires
installed Video Vision. Raw `tests-after-owner-review.txt` SHA-256
`7bc1bb5c07e136dca6e2460d99f8afb6a6933025dc288b533c7e698cb123bd0f`.
`git diff --check` also exited 0. No delegated reviewer was used.

Private raw evidence directories, retained with owner-only permissions:

- `/home/danny/.codex-web-http/canaries/active-native-20261013-01` — failed early binding, no exec.
- `/home/danny/.codex-web-http/canaries/active-native-20261013-02` — successful native route, actual browser snapshots, native events, result, completion, tests, screenshot and manifests.

| Artifact in successful directory | SHA-256 |
| --- | --- |
| `receipt.json` | `908945892f93279e97f48ae527db736c6d5c7a6b6f14613855b4a831480b7d2a` |
| `native-result.json` | `a0e4d6a05f805c4ba37b9b83fdff430a60b17a781cabf8e270f7bc22312bb00a` |
| `mcp-completion-summary.json` | `69e4aa7784fea032d2a5913808a527277a1a650b654dd30beea8a8610eb8c92b` |
| Original controller `hashes.json` | `e64507be0b05629cd9116656030086159ee4eab8f7fd8990a2e2fd7efedd5c14` |
| `browser-final.txt` | `7df83aeec226b7c8787abaf6fac4b25c556cde1cbf652be5b72492c6f4b1a6d2` |
| `browser-result-bottom.png` | `f0d2d590ddb073b1cb1b950107e9d45e6c7672bfc82c104a626a4dcee3de3e08` |

Global `~/.codex/config.toml` remains SHA-256
`c2ae08740df53819e9765f0a74d3d6b60705438b25379fb3eb2b73ca99f1aa75`.
It has no global `openai_base_url`. The existing ISyMCP tunnel was restarted
with its existing alias/profile/key-file reference to load the adapter; key
values were not read or copied. No global model/provider setting changed.

## NOT_DEMONSTRATED

This adapter in Codex Desktop App; live native tool_call (fixture tested only);
arbitrary coding tools; native background
process control; cancellation/resumption; unattended browser binding; a full
multi-turn visible Chrome provider; progressive final/reasoning streaming;
exact final equality between Chrome and Codex; independent delegated review.
The author reviewed this slice alone, as requested. M0 remains open for its
remaining client/origin/lifecycle requirements; this live coding round trip
does not close M1–M5 or establish "100%" general compatibility.
