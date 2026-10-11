# Visible Chrome conversation with native Codex execution

Status: proposed written specification for review. No implementation or live
acceptance gate is demonstrated by this document.

## Intent and agreed scope

Danny wants a visible Chrome conversation to supply the reasoning and visible
conversation for an isolated Codex CLI or Codex App session. The user can
interact with the visible conversation, with automatic bootstrap/submission
for the Codex entry. Codex executes coding tools using its own runtime,
sandbox, approvals and process sessions. The connector teaches the model how
to use ISyMCP through a concise guide, rather than requiring a long pasted JSON
response contract.

The bridge returns actual tool results automatically. The user approved that
choice and requested Chrome first. The user subsequently clarified that the
Codex entry must also open Chrome and submit its short bootstrap automatically.
Headless operation is a later project,
after the visible path passes its independent acceptance gates. Existing
audio/video tooling remains available under its current authorization model.

The user's input-mode answer prefers turns initiated from Codex, with two
explicit entry routes:

1. **Codex entry:** invoke Codex ISyMCP with a request to open the visible Web
   conversation. The launcher prepares the owned runtime, creates a real token,
   attaches the correct connector and sends the concise bootstrap automatically.
   Subsequent Codex user turns remain bound to that conversation.
2. **ChatGPT.com entry:** invoke the same connector from the browser. Its
   control tools inspect whether the owned reasoning daemon and isolated Codex
   client are running, and can start/connect them within the user's authorized
   session. The guide/inventory then exposes the permitted capabilities.

This clarification supersedes a blanket prohibition on browser submission
automation. It does not authorize resubmission after ambiguous sends, hidden
model fallback or operation of unrelated browser tabs. The selected entry is
part of the receipt, not inferred from text that merely resembles a mention.

## What the code currently establishes

- Baseline inspected: worktree `chatgpt-http-mcp-impl`, commit `5c3a6eb`, branch
  `codex/web-provider-cli-app`. The worktree was clean at inspection.
- `src/mcp/SKILL.md` already defines connector start, inventory, execution and
  completion. `codex_turn_start` serves this guide with its hash. A separately
  authorized request file is optional; it is not required for this workflow.
- `src/responses/task-turn.ts` currently submits browser messages and decodes
  model-authored `kind: call/final` envelopes for the external Codex tool loop.
- `src/web-responses.ts` awaits the complete task result before constructing
  SSE. It therefore does not currently provide live native Responses streaming.
- `src/web-turn.ts` has partial-text callbacks, but its existing navigation,
  composer selection and submission lifecycle is an automated sender. A
  passive observer requires its own lifecycle, not just `headed: true`.
- `src/mcp/main.ts` currently executes registered sessions through its local
  sandbox. Its native-looking names do not establish dispatch to an active
  external Codex task. That distinction must remain explicit.
- `src/codex-conversation.ts` already binds launch receipts and canonical URLs;
  the CLI launcher uses process configuration and the App uses isolated state.

The user's screenshot reports `web_tool_protocol_invalid`. It demonstrates a
decoder failure, not the particular contents of the failed browser response
or successful native coding execution. Do not upgrade that evidence.

## Reference and considered approaches

Reference: miuuyy/codex-chatgpt-web, public `README.md`, `docs/architecture.md`,
`src/adapters/chatgpt-web/index.ts`, `mcp-server.ts`, `browser-worker.ts` and
`src/bridge.ts`, inspected on 2026-10-11. Local origin reference commit:
`b6ca2d3f91f8a2ba140b522fe3b3c50b4ebffa2d`. The local checkout also contains
ISyCo changes and must not be described as pristine upstream.

1. Keep the existing JSON-answer adapter and improve its parsing. This retains
   the conflict between normal connector conversation and model-authored
   transport envelopes; it does not satisfy the requested interaction.
2. Reproduce the reference's manual Zero Risk mode. It uses explicit manual
   submission and MCP start/completion, but does not observe browser DOM and
   therefore does not supply the requested browser-derived live display.
3. Add a visible, user-controlled browser driver with a passive observer and
   an active-Codex broker. Recommended: separate human interaction, execution
   and display while retaining the existing isolated launch boundaries.

Reference documentation:
https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/architecture.md

## Components and authority

### Visible browser driver

Use Chrome with an ISyMCP-owned profile and an explicitly bound tab. Opening
the browser and binding the requested conversation are allowed launcher work.
The user signs in. For the Codex entry, select and verify the requested model
and registered connector, then submit exactly once. Automatic bootstrap is a
short connector mention, real capability and guide/start instruction; it is
not a model-authored JSON response contract. Later Codex prompts use the same
verified tab. For the ChatGPT.com entry, the user controls the existing browser
conversation. Never change account/workspace, silently select a different model
or operate unrelated tabs. Failure to verify the intended connector/model is
explicit and occurs before sending.

Login persistence uses that profile; do not copy authentication from another
profile or expose a remote browser-control port. The browser surface must
remain visible for this release. Unexpected headless startup is an error.

### Passive observer and conversation identity

Observe only the bound tab and logical message identities, including user
submissions, visible assistant text, visible progress/status and completion.
Bind the Chrome conversation URL, logical browser message ID, isolated launch
ID, native thread ID and native turn ID. Missing or ambiguous identity cannot
be treated as a new submission. Virtualized/remounted old messages must not
replay history, trigger tools or create another native turn.

Human chat text is content, not a tool-execution channel. A fenced JSON object,
shell command or text resembling a tool call must never execute merely because
the observer saw it. Browser close, navigation away and cancellation terminate
the current observation explicitly; browser reconnection does not resend.

### Active-Codex broker

Register the current client's exact function/custom/namespace registry and
scope as a private, revocable turn capability. Bind it to one native thread,
turn, launch and browser conversation. Start/inventory returns the guide and
exact authorized tool declarations needed by the connector.

For a valid connector call, create one correlated native tool request and
deliver it through the active Codex client's supported execution protocol.
Codex owns execution, approval and process lifetime. Await the corresponding
native result and resolve the original MCP invocation with that actual result.
ChatGPT then continues the same response using the ordinary MCP round trip;
no synthetic browser user message is needed to return an MCP tool result.

The existing local sandbox executor remains a separately named standalone
session capability. It must not become a fallback when active-Codex dispatch
is unavailable. Report the missing runtime rather than claim native execution.

Validate exact tool schemas, workspace scope, call IDs, result type and turn
ownership. Repeated identical call IDs replay the same result; changed
arguments or another owner are rejected. Cancellation settles pending MCP
calls with an explicit outcome and revokes the active capability. Tool
timeouts must settle before the tunnel deadline.

### Guide / skill

Reuse the current guide as the instruction source and package it for clients
that support installed skills. Do not promise a universal `/ISYMCP` command
without validating the target client's invocation interface. Selecting the
registered connector remains necessary.

A short initial message identifies the connector, supplies a real capability
and states the user's task. The first connector call returns the guide and
current authorized execution metadata. A static skill cannot replace dynamic
tool schemas, native policies, permissions or required task context. Preserve
those requirements without dumping unrelated filesystem content into prompts.

### Event stream

The bridge constructs transport JSON from observed events and actual broker
traffic. The model is not required to write a `kind: call/final` envelope for
this mode. Stream through native Responses events supported by the installed
client: text deltas, visible progress summaries, real function/custom calls,
matching results and a terminal response.

Only visible browser progress and reasoning summaries can be relayed. There
is no claim to retrieve hidden reasoning. Never invent reasoning or inflate a
final response into delayed chunks and label that live streaming.

Maintain message identity, ordered sequence numbers and accumulated text.
The incremental Markdown serializer must preserve complete code blocks,
lists and formatting. If Chrome revises a streamed prefix, use a supported
replacement mechanism or stop with an explicit projection error; do not
append duplicated text. Terminal output must equal the final observed answer.

The event journal supports reconnect from an acknowledged cursor. Recovery
replays committed events, not physical sends or tool executions. Its records
and content are private; public evidence must exclude tokens and login data.

## Input and native history: required contract proof

Responses is an outgoing response protocol for a request already owned by
Codex. It cannot inject an unsolicited user message into Codex history.

For Codex-originated turns, the browser submission is bound to the already
active native request. For browser-originated turns, a conversation driver
must create exactly one genuine native user turn through a supported client
interface before tools are dispatched. Capture the original user text and
its logical browser message ID; do not substitute an invented continuation.

There must be exactly one writer of the native thread. Demonstrate the
installed CLI and App ownership/attachment interfaces independently. Do not
edit history databases, remove writer locks, attach competing app-server
writers or route the user's global Codex configuration through the bridge.
If a client cannot support browser-originated turns with a single writer,
that mode remains NOT_DEMONSTRATED for that client, with a concrete blocker.
Read-only mirroring must not be advertised as canonical native history.

For the ChatGPT.com entry, inspect the actual connector metadata to determine
what source-conversation identity is available. A browser URL must be explicitly
bound and verifiable, not guessed from a tool name or account-wide history.
If metadata cannot identify the source page, an explicit guided URL/tab binding
is required for DOM observation. A successful MCP-only operation without an
observed source page must not be advertised as live browser streaming.

## User experience

Add a clear guided launcher entry for a visible Chrome conversation. Choose
CLI or App and an explicit workspace. Open isolated Codex state and Chrome,
then show a concise connection status. The Codex entry attaches the connector
and sends the short first message automatically. The ChatGPT.com entry starts
from the user's explicit connector invocation and uses the control-plane
status/connection flow. Confirm binding only after a real start and correlated
browser/native identities. A typed @mention without a real tool call is not
proof that the launch action ran.

Show visible text progressively, genuine tool activity and explicit waiting
for approval. Tool results return automatically through MCP. Later turns
retain the same authorized conversation while receiving fresh native turn
ownership. Cancel ends pending work cleanly. Resume uses exact committed IDs;
no implicit `--last`, arbitrary conversation adoption or automatic resend.

Existing media operations and older adapter routes retain their documented
behavior. The new path is opt-in and does not rewrite global models, routing,
credentials, existing tunnels or user chats.

## Reachable control plane and extensible capabilities

Keep a lightweight, independently supervised connector/control process
reachable through its own tunnel while the reasoning/browser daemon may be
stopped. The remote connector cannot check or start a PC that has no reachable
control process or tunnel. Report that limitation in the guide and retain a
local launcher recovery command; do not claim remote self-start from total
shutdown. The idle control plane does not observe unrelated tabs or poll
native model conversations.

Proposed new control tools (names must be finalized and exposed in the actual
catalog before being documented as invocable):

- `isymcp_status`: inspect the control process, owned daemon, tunnel reachability
  and exact isolated Codex client/profile. Report observed states and versions;
  do not include tokens, credentials or unrelated process inventories.
- `isymcp_runtime_start`: start only the configured ISyMCP-owned components for
  an authorized session. It is idempotent, returns progress/receipt promptly and
  does not kill or replace another client/tunnel to resolve a port conflict.
- `isymcp_conversation_open`: create or resume one explicitly identified
  conversation/launch with its authorized workspace and entry route. Return
  actual native/browser IDs after verified binding, not a guessed URL.
- `isymcp_guide`: retrieve a versioned guide by a catalogued capability ID.
  Return verified content and hash; no arbitrary local paths.
- `isymcp_capabilities`: discover the installed, permitted modules and exact
  tool schemas. Distinguish advertised, available and active capabilities.

Use an internal module catalog with stable IDs, versions, descriptions,
guide references, schemas, permission requirements and runtime adapters.
Coding, media and control are initial modules. Future modules register through
that boundary instead of growing a generic unrestricted tool executor.
Discovery never grants permission. Changes to public tools still require the
client's real schema-refresh/install mechanism; do not promise that a catalog
entry alone becomes a newly callable ChatGPT tool.

The control plane may load only explicitly authorized session workspaces.
Without a session grant, use the local guided workspace chooser; a remotely
supplied filesystem path is not authorization. Dynamic tools must be present
in the current client's declared registry or installed module catalog, with
their own scope checks and cancellation contract. Tokens cannot widen scope
by changing an entry label or replaying them in another native turn.

The skill/guide explains how to start, discover and use these capabilities.
The public connector description tells GPT to fetch the guide when required.
Neither replaces the server's enforced authority or the native client's
instruction hierarchy.

## Acceptance milestones

Each milestone has a concrete gate. Stop and repair failed gates before
expanding to the next milestone; mocks are not live-client acceptance.

### M0 — prove the installed client / input contract

Record real CLI and App declarations, calls, results, source-connector metadata
and supported thread ownership. Demonstrate one user turn per selected entry,
including the ChatGPT.com control/status/connection path and its conversation
binding. No database mutation
or competing writers. Preserve private raw evidence and SHA-256. A failure
here is an architectural blocker, not permission to imitate native tools.

### M1 — Chrome binding and passive observation

Exercise automatic Codex-entry bootstrap with a real selected connector,
manual ChatGPT.com submission, two identical answers with different logical
IDs, remount/virtualization, wrong-tab navigation, cancellation and resume.
Confirm that only the driver submits; the observer never sends or calls tools.
Demonstrate one retained conversation with distinct native turns and no
duplicate history entries. Verify guide retrieval without a pasted JSON
transport contract or mandatory local task file.

### M2 — native execution via real MCP

Live `start -> inventory -> exec -> result -> complete` with a unique marker.
Then demonstrate native Begin Patch on a newly created scratch fixture,
interactive stdin/background lifetime, dispatch through tool_call and an
expected denied/failing operation. Native CLI/App evidence must identify the
actual executor. Test wrong token, wrong owner, schema errors, duplicate IDs,
nonzero exit, lost connection and cancellation as meaningful negatives.

### M3 — progressive Responses display

Observe at least two real text updates before browser completion, correlate
their timestamps with client events, and compare the final text exactly.
Include Markdown/code blocks, tool boundaries, visible progress, reconnection
and cancellation. Report time to first visible text separately from total
duration. No fixed latency threshold is asserted before measurement.

### M4 — guided CLI and Codex App acceptance independently

For each client, demonstrate launch, three conversational turns, actual tool
execution, cancellation and resume on the same canonical conversation. Exercise
both entry routes; status/start must distinguish reachable control plane,
stopped reasoning daemon, stopped isolated App and completely offline tunnel.
Repeat start requests without duplicate clients, sends or native turns.
Verify unchanged global configuration and unaffected native-model sessions.
Check all new guided menu actions and standalone CLI parsing in temporary
environments. An App screenshot alone does not prove an unobserved tool ran.

### M5 — repeatability, documentation and review

Run the appropriate focused regressions and full suite, with bounded live
account canaries kept distinct from hermetic CI. Retain failure evidence and
SHA-256 manifests. Update GUIA.md only with executed commands and observed
output; clearly label remaining NOT_DEMONSTRATED behavior. Review ownership,
event ordering, cancellation, reconnect and authority boundaries before
claiming the visible release ready.

Only after M0–M5 pass may a separate headless design be proposed. No current
acceptance criterion depends on implementing headless or promising perfect
stability of an external browser service.

## Delivery boundaries

This specification does not authorize replacing the reference repository,
deleting old evidence, closing unrelated sessions or modifying global routing.
Future code changes belong to the existing implementation worktree and must
preserve standalone MCP/media compatibility. Any imported reference code
requires its MIT attribution. The implementation plan follows written-spec
review and must map every task to the acceptance milestones above.
