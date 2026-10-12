# Native2 recovery and native CLI proof — 2026-10-12

**M0 remains open.** A real remote Native2 `codex_exec` call completed through
the installed Codex CLI's native executor. The owned App canary is rearmed
and awaiting input; its successful command/result round trip remains
**NOT_DEMONSTRATED**. M1 has not started. This dated follow-up preserves the
[October 11 observations](2026-10-11-visible-host-contract.md) as historical
evidence. The probes use deterministic Responses providers, not GPT.com
reasoning.

## Recovery and isolation

`codex-chatgpt-web` retains its original tunnel, profile directory and
installed 6.1.7 native MCP target. Its credential changed from an unavailable
environment reference to an existing private key-file reference already used
by the separate media runtime. No key value was read, copied into config or
published. The previous profile is preserved. The historical environment
reconnect helper now refuses to replace a saved credential reference.

The log records `poller recovered; polling operational`. A fresh connected
inventory request with an intentionally invalid capability returned
`turn token is invalid, expired, or revoked`, without execution. Both tunnel
aliases report running and ready with HTTP 200 from `/healthz` and `/readyz`.
Control-plane poll health is **unknown** in the status tool, which lacks a
live admin UI snapshot. Local readiness alone does not prove remote acceptance
or stable networking.

Fresh SHA-256 comparisons show unchanged global Codex config, media profile
and reference runtime config, respectively:

- `c2ae08740df53819e9765f0a74d3d6b60705438b25379fb3eb2b73ca99f1aa75`
- `fc86c248173c927bc617621efeb3e1c457ce0cf00781a70fedab009d1ac27fb4`
- `943505f53f0e48f05fc63769ec70c469e7d6f8c63b428dcc2a5d46ab82d5a783`

The modified Native2 profile hashes to
`98d874ee8fbf4415dac1cab216706d14104253246c174406c2d96bb454b0a060`.

## Demonstrated remote MCP-to-native CLI loop

A real connected Native2 `codex_exec` invocation entered the installed broker,
which delivered a native `exec` custom call to an owned Codex CLI app-server.
Its registered `exec_command` ran one unique `printf` canary in a scratch
workspace. The actual `commandExecution` event has exit code 0 and matching
stdout. The next Responses request returned `custom_tool_call_output` with
the same call ID; this actual output completed the pending remote MCP call.
The CLI exited 0 after two Responses requests.

A separate control proved the gateway without experimental code-mode settings.
The request had no API-level `tools` array; the gateway registry supplied the
actual native name. Array-shaped `input_text` results are preserved and mapped
to MCP text rather than coerced to `[object Object]`.

## App failure and rearming

The original App receipt records `broker_timeout:owner_next` without a native
call or result: the test caller was not serviced in time. Further submits
returned `m0_app_turn_pending; no resubmission`. That failed receipt is intact.
The fixture also treated an auxiliary thread-title request as an execution
candidate. The continuation reuses the existing local-title guard, binds the
actual scratch thread and turn, and connects the installed native MCP over
stdio before accepting input. Codex App remains the executor; the broker waits
for its actual result. The test no longer depends on scheduling a remote call
during a short callback window.

Live controls returned 200 for a title without tools and 409 for a foreign
thread, created no owner grant and left the fixture waiting for App input.
The owned window, profile and port 33653 were reused. App metadata contains
thread, turn and window identity keys; the scratch rollout identifies
`Codex Desktop` version 0.160.0. This identifies the failed request, not a
successful command. The local App loop and a separate remote App loop remain
pending.

## Verification and remaining gate

Private evidence is preserved under
`.superpowers/sdd/2026-10-11-visible-chrome-native-mcp/`. Capability files stay
private and excluded from manifests. The 19 hashes in
`native2-closure-evidence-20261012/hashes.json` were rechecked without mismatch.

| Artifact | SHA-256 |
| --- | --- |
| Remote CLI receipt | `c40c25772b550cd041380c0fb3d621ec35ebc66727dfdf192a032d91ecc40d9e` |
| Actual MCP result | `7767dc012d05f5531c438b53d54b5ec4511bc381b8c2d4f3a0d03425719b5492` |
| Actual native output | `94079a5a2c9c36f705bda6d673e500b0ea92422ae64acea5b8e0b1d3863b886f` |
| Stable gateway control | `76e23be0c63327b6fbac77773b56d255bbe20833fd9dcb8d22b8fb80a1089a47` |
| App preflight controls | `4e26652d80651f182830016dd1195932f2647fde505b2d49c6173bd2e7d59981` |
| Preserved failed App receipt | `86fbb32e518e6b22bd979bd57b9526845ad07f758cebb958a9c39ef94971dbda` |
| Focused tests | `746f74331905ac955637a27d928d51bb375adcecef1dd0c75b6c316ea645db6d` |
| Raw tunnel-status tools | `186ad291378576620f0ab14796a3344eaac7b08b3059d836083a548de747cd7f` |

Fresh `bun test tests/visible-host.test.ts tests/codex-app.test.ts` returned
**6 pass, 0 fail**, exit 0. The October 11 full suite was not rerun for this
documentation/probe follow-up.

Desktop execution, cancellation/exact resume, both browser-origin paths,
connector source metadata and verified Chrome model/connector attachment are
**NOT_DEMONSTRATED**. A new logged-in Chrome tab exposed effort selection
without verifying the requested model; no prompt was sent. `inspectHost`
stays conservative, and M1–M5 cannot advance on these partial results.
