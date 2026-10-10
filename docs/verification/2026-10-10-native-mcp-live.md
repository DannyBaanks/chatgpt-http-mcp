# Native MCP execution and local bootstrap — 2026-10-10

The short connector entry is demonstrated independently in ChatGPT.com.
A four-line user message explicitly selected Codex ISyMCP, supplied a real
session token and requested `codex_turn_start`. That call returned the local
guide and the hash-pinned local task. ChatGPT then called inventory, exec,
native patch, exec for verification and turn completion.

## Verification scope

| Claim | Status | Observed evidence |
|---|---|---|
| ChatGPT.com reads the guide and local task through MCP | DEMONSTRATED | Exactly four prompt lines; real `bootstrap` and `request`; subsequent tool calls match the bound task |
| ChatGPT.com performs command, native patch, read and completion | DEMONSTRATED | Three exit codes 0; matching server trace; disk file `primera linea\nMCP_PATCHED\n`; completion with zero live processes |
| Codex App invokes all eight native MCP tools | DEMONSTRATED | Remote connector calls, including image, background stdin/EOF, patch and dispatch |
| Native Codex CLI invokes the MCP | DEMONSTRATED | Installed Codex 0.162.0: start, inventory, exec of a private nonce and complete; final nonce and execution result agree |
| Installed `isymcp session mint --request-file` emits the short entry | DEMONSTRATED | Real installed wrapper; exit 0; four lines; task text absent from CLI output |
| Local request is confined and hash-pinned | DEMONSTRATED | Missing/changed files, external paths, symlinks, invalid UTF-8 and oversized content rejected; BOM retained; turn token inherits the request |
| Full repository suite | DEMONSTRATED | `bun test`: 485 pass, 1 skip, 0 fail; 486 tests across 68 files |
| Native client tool-search protocol | DEMONSTRATED locally | Typed client search events, correlated outputs and discovered schemas; Codex owns execution |
| Complete ChatGPT Web-provider CLI loop | NOT_DEMONSTRATED | Earlier real Web-provider canary failed during response capture/protocol decoding; native exec never occurred in that attempt |
| Selecting the Web provider as a Codex App task model | NOT_DEMONSTRATED | The guided App entry still rejects unsupported per-task provider setup |

The native MCP in Codex App is a connector/tool path. It does not establish
that choosing the Web bridge as the App's reasoning model works. The successful
ChatGPT.com connector canary likewise does not close the separate Web-provider
CLI gate.

## Reproduce the short entry

Write a UTF-8 task file inside the workspace. The local operator explicitly
binds it when minting the session:

```bash
isymcp session mint --cwd "$PWD" --write --request-file TASK.md
```

Select **Codex ISyMCP** in ChatGPT's composer. Paste the generated four lines;
keep the actual token private. The token is consumed by `codex_turn_start`,
which returns the installed `src/mcp/SKILL.md` in `bootstrap.content` and the
bound task in `request.content`. Existing sessions without a bound task still
use the task in the user message. A changed task requires a newly minted token.

Local task files have a 64 KiB limit. The guide is fixed package content with
a 16 KiB limit. The caller cannot choose an arbitrary guide or task path via
the MCP. Both documents reach the model in a tool result; this reduces the
initial message length, not the total context required to read them.

## Runtime and preserved evidence

Environment: Ubuntu, Bun 1.4.2 (744846f84), installed Codex 0.162.0, local
stdio MCP and the existing tunnel. Tests used isolated fixtures; live tool
writes used owned temporary workspaces. ChatGPT's observed model selection
was GPT-6 / High. Its connector canary completed in 72,692 ms.

The complete final test output is committed as
[`native-mcp-20261010-closure-tests.txt`](../evidence/native-mcp-20261010-closure-tests.txt).
Its SHA-256 is
`0bfc3e5cb394265d1b93b0051efbfe585518f88054c7b51b11d144c25559328a`.

The [evidence manifest](../evidence/native-mcp-20261010-manifest.json) records
the private raw receipt paths and SHA-256 values. Tokens, cookie state and
page screenshots remain private. Key receipts:

| Artifact | SHA-256 |
|---|---|
| ChatGPT.com connector receipt | `9624f2ef43f64c38085d860858f9a322156f55f4c84f327fd5fdde8a201b755c` |
| Connector session trace | `e240dbcdd25ea676b77515c5e2ca1d069747d6f90bdfc0b0c45a607372b4a644` |
| Connector output file | `fec19d54cc206f01cad1612520185bf102651ffc0d5acb6fa411559534dedb66` |
| Codex App eight-tool transcript | `60008d2d2c15a089799e2d814f11bc90c5f17452ef97c08b64145739b8453786` |
| Native CLI receipt | `39c0da83a6d80f2cd3d45a75c5f76743111c72bf62229275c3c0f13722ef255c` |
| App post-update process count | `4f7dedb9e6f74beb689ffcf386069b9dc48c55dc659f189eeca6073b5520a2b9` |
| Earlier Web-provider negative receipt | `b22ca2d0ea4202f0b94f079be3579cb753fd274f999eac1bdcd4dbe44c46572e` |

The global Codex configuration remained byte-identical during this work,
SHA-256 `dc56c54a75e3aeac23ab5ef1857e0d2852c7725af2926780946c277dea469f23`:
native Luna model, no global `openai_base_url`, no global provider override.

## Corrections and limits

- Native patches reject symlink escapes and stage all changes before
  publication. A later publication failure rolls back earlier changes;
  failed recovery preserves and reports its backup path. Per-file replacement
  is atomic, but this is not a multi-file filesystem transaction.
- Dispatch retry identity is scoped to a session and a call ID. Concurrent
  retries execute once; changed arguments reject; replay preserves images.
  The bounded ten-minute cache is not durable across MCP restarts.
- Final background output remains available for polling after process exit.
  Excess spawned processes are terminated if registration fails.
  Completion counts only processes that were still alive.
- The earlier Web-provider negative attempt submitted once and then rejected
  ambiguous retries. It is preserved, not replayed as a successful turn.
  A separate read-only inspection found an empty assistant renderer with a
  personality survey. The extractor now rejects that survey as an answer;
  local regressions pass. Recovery of the earlier renderer's JSON payload is
  still NOT_DEMONSTRATED.
- Older full-suite attempts and red tests remain in private evidence. They
  include the configuration-cache race in a test, a process-count regression
  during development and browser contention timeouts. The final uncontended
  suite above is the verified result after repairs; no earlier output was
  rewritten.

This report supersedes only the current status claims of the earlier
verification report. Historical evidence and its scope remain unchanged.

## Later native App reconnection report

A later affected App thread was checked read-only after repeated reconnects.
Its persisted provider was `openai` and its model was `gpt-6.1-sol`; global
routing still had no local bridge override. Its logs recorded five WebSocket
`Broken pipe` retries, followed by HTTP fallback, and model-list timeouts.
A daemon also recorded a DNS lookup failure. An unauthenticated HTTPS probe
reached the real API with the expected 401 response in 4.127 seconds.

The App's live TCP connections showed substantial send backlog, retransmissions
and RTT around 1.3–1.9 seconds. The operator confirmed a phone hotspot.
Three idle media MCP processes measured 0.0% CPU. This supports a network
congestion diagnosis; MCP causation is NOT_DEMONSTRATED. No network, App
configuration or user-thread state was modified during this inspection.

Private receipt:
`~/.codex-web-http/evidence/native-network-20261010-15a534/receipt.json`,
SHA-256 `0bf37a1566698f57e20dddd7b590505a410a462d60821386a82fdaace8bec969`.
The successful connector and local suite above do not demonstrate reliable
model connectivity on every network.
