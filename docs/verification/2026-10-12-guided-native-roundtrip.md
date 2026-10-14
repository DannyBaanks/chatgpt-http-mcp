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

## Failed manual attempt and bounded wait correction

The first manual receiver failed at 23:02:03 UTC (17:02:03 Mexico City), before
the announced token deadline. Its installed CLI reported `idle timeout waiting
for SSE` after approximately five minutes. SSE comments did not keep that
native event wait alive. The subsequent automatic HTTP retries were refused by
the probe, and cleanup revoked the broker capability. No native call was
delivered. Failed receipt SHA-256:
`e1fbe7674f822581442abe25228e70d01571387d4298d7e7f42e9e2db7ad5a98`.

The private receiver now sets `stream_idle_timeout_ms` to its bounded operator
wait plus thirty seconds, and sets `stream_max_retries=0` and
`request_max_retries=0` in its own per-process provider. A one-second negative
control reproduced the installed CLI timeout with one request and no retry.
A sixty-second positive control waited approximately forty-nine seconds, then
completed through the installed **local stdio** native MCP and real CLI command.
Positive receipt SHA-256:
`a6178a1c0f12292cf0b0cd9a086e39eab2658ff8f5f84549987b5a71a38a3491`.
The full default twenty-minute wait has not been exercised end to end.

The separate remote Native2 invocation returned `McpServerError: Session
terminated` while that positive receiver was alive. Local success does not
repair or demonstrate the remote connection. Its raw error was preserved in
the private plan workspace. No global routing configuration changed.

The subsequent real **Codex ISyMCP** Chrome conversation is documented in
[its separate report](2026-10-12-isymcp-chrome-conversation.md). It uses the
standalone sandbox, not this native reference gateway. M0 remains open.
