# Guided native tool round trip — 2026-10-12

M0 remains open. This is a disposable, narrowly scoped protocol probe, not a
working visible Chrome conversation adapter.

The control invoked the real remote **Codex Native2** connector. Its original
6.1.7 broker delivered a custom `exec` call to an isolated installed Codex CLI
0.162.0 app-server. The CLI's native command tool printed the unique marker with
exit code 0. The next Responses request carried the matching custom output,
which resolved the pending MCP invocation. Two Responses requests completed.

- Native thread: `01a13252-cc35-7871-ab38-07e64ffd4be9`.
- Native turn: `01a13252-ccd3-7460-bf2a-8af2b191600e`.
- Call ID: `call_0BY31F9mk2dP05mHcr-3ZUJRUOq94r_w`.
- Receipt SHA-256: `448cba48831e9506710145c8818ecf318e9e926bcdd64544f5ebccb62cbba375`.
- Private raw records: `.superpowers/sdd/2026-10-11-visible-chrome-native-mcp/manual-native-control-20261012-01/`.

The scoped receiver accepts the exact installed connector's command wrapper
only for the generated marker command. Its guard control accepted that command
and rejected appended JavaScript, a different command and a different working
directory. It permits one delivered call, rejects provider resubmission, and
expires after twenty minutes. Its own native final is explicitly a deterministic
transport-fixture acknowledgement. It is not presented as GPT's answer.

The receiver uses a new private Codex home and scratch directory, per-process
provider settings, a loopback provider with a run-specific credential, and a
read-only native sandbox. It does not start globally configured MCP servers or
copy authentication. The global Codex configuration, standalone media tunnel
profile and reference runtime configuration retain their previously verified
SHA-256 values.

## Manual next step

1. Use the actual ChatGPT website in Chrome and select **Codex Native2**. Record
   the model shown by the website; the receiver's native model-catalog label does
   not establish which model answered on ChatGPT.com.
2. The operator arms a fresh receiver and supplies its generated private
   `compose.txt`. Paste that five-line message once. It contains the short-lived
   token and exact marker command; no placeholder needs to be invented.
3. Preserve GPT's actual reply and the conversation URL. Compare its reported
   marker/output with the receiver's native call/result and completed receipt.
   If the connector or token is unavailable, record the literal failure and do
   not use the standalone executor as a substitute.

The private operator command, executed successfully for the control, is:

```bash
bun .superpowers/sdd/2026-10-11-visible-chrome-native-mcp/manual-native-probe.ts \
  --evidence-dir .superpowers/sdd/2026-10-11-visible-chrome-native-mcp/manual-native-control-20261012-01
```

Each execution requires a new output directory; the command above names
preserved evidence and must not be rerun with that destination. Operator guard
check: `bun .superpowers/sdd/2026-10-11-visible-chrome-native-mcp/manual-native-probe.ts --validate`.
The private script is a disposable M0 artifact, not a shipped CLI command.

## Not demonstrated

Chrome is absent from the current browser-control inventory. No user message
has been sent by this probe in Chrome. Website connector attachment, selected
model, logical browser message identity, automatic browser observation, mirrored
GPT final, desktop remote route, cancellation and exact resumption remain
unverified. User-provided final text or URL is an operator report, not independent
browser-observer evidence. No M1 implementation or full-conversation claim is
made.

**Codex ISyMCP** is the other connector, with its existing standalone workspace
sandbox and registered media. That connector's all-tools battery and this native
owner control test establish different execution paths.
