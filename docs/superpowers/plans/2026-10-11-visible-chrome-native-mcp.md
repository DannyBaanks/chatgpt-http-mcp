# Visible Chrome Native MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the proposed native execution method, or superpowers:subagent-driven-development if the user chooses delegation. Implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an isolated Codex CLI or App conversation use visible Chrome reasoning, real MCP calls, native Codex execution and progressive display, starting from either client.

**Architecture:** A reachable control process supervises owned sessions. Each session has a visible browser driver, passive observer, private event journal and turn broker; the broker bridges actual connector invocations to the active Codex Responses request and resolves them only from matching native results. Existing standalone sandbox/media sessions and the legacy JSON-answer adapter remain separate.

**Tech Stack:** TypeScript, Bun 1.4.2, playwright-core 1.62.0, MCP SDK 1.30.0, existing SDK JSON Schema validation, Unix-domain IPC, installed Codex CLI/App supported protocols.

**Spec:** `docs/superpowers/specs/2026-10-11-visible-chrome-native-mcp-design.md`, approved by Danny on 2026-10-11; commit `43f033a`, SHA-256 `958988f0a9d8a89107bfdfbe574141714dbe3a2bb34c63c37222c9d2d3695ed6`.

## Global Constraints

- Chrome remains visible; headless is a separate project after M0–M5 pass.
- Codex owns native execution, sandbox, approvals and process lifetime. No local-executor fallback for an unavailable native owner.
- Automatic submission is allowed for the explicit Codex entry; the ChatGPT.com entry observes the user's existing conversation. Ambiguous sends never resend automatically.
- The user signs in to the owned Chrome profile. Do not copy authentication, change account/workspace or operate unrelated tabs.
- One native thread has exactly one writer; no history database mutation, writer-lock removal or competing app-server.
- No global model/provider/routing changes. Preserve the official HTTP mitigation, existing tunnels, media, reference checkout, user sessions and historical evidence.
- A real connector attachment and a verified selected model precede sending. A typed mention alone proves neither invocation nor launch.
- Tool results return through the pending MCP invocation. The model does not author transport JSON in this mode.
- Only visible progress/reasoning summaries may be mirrored. Never invent reasoning or delay a completed answer to simulate streaming.
- Remote control requires a reachable control process and tunnel. A workspace path supplied remotely does not grant access.
- Private raw evidence includes commands, environment, timestamps, exit codes and SHA-256. Public receipts exclude tokens, login data and user context.
- No deletion or destructive replacement is part of this plan. Commit only task paths; preserve old routes and receipts.

## Review Focus

1. Two connectors share a display name: verify the configured connector identity, not the first matching label (Task 3).
2. Two equal user prompts or assistant replies are distinct messages; remounts of one message are not new turns (Tasks 3, 6).
3. Network loss after a command was delivered does not authorize executing it again, including after process restart (Tasks 4, 5).
4. Emoji, nested Markdown and prefix revisions must not produce broken or duplicated final text (Tasks 3, 5).
5. A daemon dies and its PID is reused by another application: status/start must not adopt, signal or kill that application (Task 2).

## Execution and milestone gates

Proposed method: implement in this session without parallel workers, then request one independent whole-branch review. If delegated review is selected, respect Danny's model preference: GPT-6 Luna/high or GPT-6.1 Sol/low or medium. The method and written plan require user review before implementation.

Use the existing worktree `/home/danny/Development/ISyCo Git/chatgpt-http-mcp-impl`, branch `codex/web-provider-cli-app`. Recheck its status and applicable instructions before every task. Do not recreate the reference or synchronize other checkouts.

| Gate | Tasks | Advancement requires |
| --- | --- | --- |
| M0 | 1 | Installed CLI and App protocol/ownership proof, connector source-metadata inspection, both input-origin feasibility probes |
| M1 | 2–3 | Reachable controls, guide, real bootstrap/binding and passive observation with stable identities |
| M2 | 4 | Actual MCP-to-native coding round trips and negative controls |
| M3 | 5 | At least two observed text updates before completion; exact terminal equality |
| M4 | 6 | Both origins independently in CLI and App, three turns, cancel/resume, unchanged global config |
| M5 | 7 | Regression suite, independent review, hashed evidence and executed human guide |

A task's passing fixture tests do not satisfy its live milestone. Complete the named live gate before advancing. Failure means repair the same gate; an unsupported client capability is a concrete blocker requiring a design revision, not permission to imitate success. M0 uses disposable probes because production control tools arrive in Task 2.

## File responsibilities and shared interfaces

New files live under `src/visible/`; do not spread ownership across the existing legacy adapter. The plan introduces these contracts in Task 1:

```ts
type ClientKind = "cli" | "app";
type EntryKind = "codex" | "chatgpt";
type NativeDeclaration = Record<string, unknown>; // exact client declaration, validated before exposure
type NativeOutput = Record<string, unknown>; // exact correlated client result, not a synthesized success
interface OwnerRef { launchId: string; threadId: string; turnId: string; epoch: string }
interface BoundTurn extends OwnerRef { browserUrl: string; userMessageId: string; entry: EntryKind }
interface HostContract {
  client: ClientKind; version: string; evidenceSha256: string;
  supported: boolean; blocker?: string;
  openThread(grant: string, requestId: string, signal: AbortSignal): Promise<{threadId:string; writerId:string}>;
  startTurn(threadId: string, input: { text: string; browserMessageId: string }, signal: AbortSignal): Promise<OwnerRef>;
  cancelTurn(owner: OwnerRef): Promise<void>;
  resumeThread(threadId: string): Promise<{ threadId: string; writerId: string }>;
}
interface ModuleSpec {
  id: "coding" | "media" | "control"; version: string; description: string;
  guideId: string; tools: NativeDeclaration[];
  permissions: string[]; adapter: "active-codex" | "registered-media" | "owned-control";
}
type Invocation = { callId: string; wireName: string } &
  ({ kind: "function" | "tool_search"; arguments: Record<string, unknown> } | { kind: "custom"; input: string });
interface ConnectorResult { content: unknown[]; structuredContent?: unknown; isError?: boolean }
type BrowserEvent =
  | { kind: "user"; messageId: string; text: string }
  | { kind: "assistant"; messageId: string; markdown: string; complete: boolean }
  | { kind: "progress"; messageId: string; text: string }
  | { kind: "closed"; reason: "cancel" | "navigation" | "browser_exit" };
interface JournalEntry { sequence: number; at: string; owner: OwnerRef; event: BrowserEvent | { kind: "tool"; invocation: Invocation } | { kind: "result"; callId: string; output: NativeOutput } }
type ModuleView = ModuleSpec & {state:"advertised"|"available"|"active"};
type ComponentState = "running" | "stopped" | "unknown" | "foreign";
interface RuntimeStatus {
  control: ComponentState; tunnel: ComponentState; daemon: ComponentState; client: ComponentState;
  jobs: ControlReceipt[]; launchId?:string; version:string;
}
interface ControlReceipt { jobId:string; state:"pending"|"ready"|"failed"; error?:{code:string; message:string} }
interface VisibleBrowser { page: import("playwright-core").Page; close():Promise<void> }
interface JournalPort {
  append(owner:OwnerRef,event:JournalEntry["event"]):Promise<JournalEntry>;
  replay(owner:OwnerRef,afterSequence:number):AsyncIterable<JournalEntry>;
}
interface BrokerPort {
  nextNativeCalls(owner:OwnerRef,signal:AbortSignal):Promise<Invocation[]>;
  acceptNativeOutput(owner:OwnerRef,callId:string,output:NativeOutput):Promise<void>;
  revokeNativeTurn(owner:OwnerRef,reason:string):Promise<void>;
}
interface VisibleResponseDeps {
  journal:JournalPort; broker:BrokerPort; browser:VisibleBrowser; owner:BoundTurn; signal:AbortSignal;
}
interface VisibleReceipt {
  version:"isymcp-visible-conversation/1"; entry:EntryKind; client:ClientKind;
  launchId:string; threadId:string; url:string|null; profileRef:string; state:"binding"|"ready"|"blocked";
}
interface CanaryReceipt {
  client:ClientKind; entry:EntryKind; command:string[]; environment:Record<string,string>;
  versions:Record<string,string>; launchId?:string; threadId?:string; url?:string;
  stages:{name:string; outcome:"DEMONSTRATED"|"FAILED"|"NOT_DEMONSTRATED"; reason?:string}[];
  firstVisibleTextMs?:number; totalMs:number; finalEqual:boolean;
  artifacts:{path:string; sha256:string}[];
}
```

`src/visible/contracts.ts` owns these types and typed errors. Native Responses call/output wire shapes remain derived from actual installed declarations; M0 records them instead of inventing another execution API.

| File | Responsibility |
| --- | --- |
| `scripts/probe-visible-host.ts` | Opt-in installed-client/source-metadata proof and private receipts |
| `src/visible/host.ts` | Proven client ownership/start/cancel/resume adapters |
| `src/visible/modules.ts` | Permission-filtered catalog and hashed fixed guides |
| `src/visible/control.ts` | Owned process status, idempotent start, control job receipts |
| `src/visible/connector-control.ts` | Five concrete MCP control tools and input schemas |
| `src/visible/browser-driver.ts` | Visible owned Chrome, actual attachment and submit-once ledger |
| `src/visible/browser-observer.ts` | Read-only logical-message observations and Markdown snapshots |
| `src/visible/journal.ts` | Private ordered append/replay and publication checkpoints |
| `src/visible/broker.ts`, `src/visible/broker-ipc.ts` | Bound capabilities, correlated calls/results and private IPC |
| `src/visible/responses.ts` | Progressive native Responses projection and continuation routing |
| `src/visible/coordinator.ts` | Two entry routes, canonical native history, exact cancel/resume |
| `scripts/e2e-visible-chrome.ts` | Bounded account canaries with separate client/origin receipts |

Existing integration points: `src/mcp/main.ts`, `bootstrap.ts`, `identity.ts`, `catalog.ts`; `src/config.ts`, `web-responses.ts`, `codex-conversation.ts`, `codex-app.ts`, `isymcp.ts`, `menu.ts`. Reuse `domToMarkdown`, model selection and receipt validation. Preserve `runTaskTurn` and `toolPrompt` for the legacy route. Registry validation may be shared without applying the legacy text-envelope restriction to real MCP results.

---

### Task 1 — M0: prove the installed host and both input contracts

**Files:** create `src/visible/contracts.ts`, `src/visible/host.ts`, `scripts/probe-visible-host.ts`, `tests/visible-host.test.ts`; create `docs/verification/2026-10-11-visible-host-contract.md` after running probes.

**Interfaces:** consumes actual installed CLI/App declarations, isolated launcher settings and existing `resolveTaskIdentity`. Produces the shared contracts above and `inspectHost(client: ClientKind): Promise<HostContract>`; a report with separate CLI/App and input-origin outcomes. `supported=false` is a failure to advance, never a fallback.

- [ ] Write the failure tests. Test `rejects_competing_writer` asserts that a second writer is refused without canceling the first; `matches_native_call_result` asserts a unique printed nonce, declared wire name and matching call ID; `source_identity_missing_requires_binding` asserts missing URL metadata needs explicit binding. All assertions must inspect transport records, not a model's final success text.

  Assertion anchor for `matches_native_call_result` after the deterministic provider requests a native nonce command:
  ```ts
  expect(nativeResult.call_id).toBe(nativeCall.call_id);
  expect(actualStdout.trim()).toBe(nonce);
  expect(executorClient).toBe(selectedClient);
  ```
- [ ] Run `bun test tests/visible-host.test.ts`; require the new cases to fail before their implementation.
- [ ] Implement the disposable probe and host adapter using the installed supported interface. Capture `/v1/responses` declarations and the next request's actual function/custom output; prove `startTurn`, cancellation and exact resume with one writer. Inspect connector `_meta`/requestInfo by redacted shape, retaining sensitive raw data privately. Derive IPC/frame and tunnel deadlines from installed contracts and pin them in the report.
- [ ] Run the fixture test, then `bun run scripts/probe-visible-host.ts --client cli --entry codex` and repeat for `app/codex`, `cli/chatgpt`, `app/chatgpt`. Each run uses a fresh owned scratch workspace/profile and a visible page; the ChatGPT-origin probe records a real user message and creates exactly one native turn without resending it. Login or missing connector requires the user; report that state explicitly.
- [ ] Record exact versions, writer IDs, tool schemas/call/result IDs, metadata availability, cancellation and SHA-256. Expected outcome is four demonstrated input/host combinations, not four screenshots. Do not use a standalone app-server as proof of desktop App ownership. If an interface is absent, stop at M0 with the concrete unsupported operation.
- [ ] Commit only Task 1 paths: `test: prove visible Chrome native host contract`.

### Task 2 — M1: versioned guides, reachable control and module catalog

**Files:** create `src/visible/modules.ts`, `src/visible/control.ts`, `src/visible/connector-control.ts`, `tests/visible-control.test.ts`, `tests/visible-modules.test.ts`; modify `src/mcp/main.ts`, `src/mcp/bootstrap.ts`, `src/mcp/identity.ts`. Keep `src/mcp/SKILL.md` as the existing coding guide source.

**Interfaces:** consumes `HostContract` and `ModuleSpec`. Produces `listModules(grant: string | null): ModuleView[]`, where `ModuleView` adds `state: "advertised" | "available" | "active"`; `readGuide(id: string): { id: string; version: string; sha256: string; content: string }`; `runtimeStatus(launchId?: string): Promise<RuntimeStatus>`; `startOwnedRuntime(grant: string, client: ClientKind, requestId: string): Promise<ControlReceipt>`. `RuntimeStatus` lists only owned control/tunnel/daemon/client observed states; `ControlReceipt` has `jobId`, `state: "pending" | "ready" | "failed"` and optional typed error.

- [ ] Write `catalog_discovery_is_not_authority` (ungranted coding unavailable), `guide_rejects_path_and_preserves_hash` (no caller-supplied path), `start_twice_reuses_job`, `dead_pid_reuse_is_foreign`, and `tunnel_unknown_is_not_connected`. Assert that foreign PIDs are neither adopted nor signaled and readiness is based on handshake, not a PID alone.

  Assertion anchor for `start_twice_reuses_job`, using equal grants and request IDs concurrently:
  ```ts
  expect(secondReceipt.jobId).toBe(firstReceipt.jobId);
  expect(ownedSpawnCount).toBe(1);
  expect(foreignSignals).toEqual([]);
  ```
- [ ] Run `bun test tests/visible-control.test.ts tests/visible-modules.test.ts` and observe the new failure cases.
- [ ] Implement fixed guide references and schema publication from registered declarations. Preserve existing guide size bounds. `isymcp_capabilities` filters by grant; `isymcp_guide` accepts only catalogued IDs. Connector instructions tell GPT to retrieve the guide; they do not contain the legacy response contract.
- [ ] Implement five public tools: `isymcp_status({launch_id?})`, `isymcp_runtime_start({session_token,client,request_id})`, `isymcp_conversation_open({session_token,client,entry,request_id,launch_id?,conversation_url?})`, `isymcp_guide({capability_id})`, `isymcp_capabilities({session_token?})`. `isymcp_conversation_open` initially returns `conversation_adapter_unavailable` until Task 6 connects the coordinator; catalog state must reflect that. No remote `cwd` parameter. Use existing operator-authorized session grants; never echo tokens.
- [ ] Supervise a lightweight control process independently of the reasoning daemon. Starting owns only receipts/verified children; port conflicts return `runtime_port_conflict`, not kill. Registration exposes exact schemas through real MCP, with finite job-state polling through `isymcp_status`.
- [ ] Run the focused tests and real stdio initialize/list-tools/call tests. Stop an owned test reasoning daemon while leaving its test control/tunnel reachable: real remote status works, start is idempotent. A completely offline control/tunnel remains a local-recovery condition; record it as such.
- [ ] Commit only Task 2 paths: `feat: expose scoped ISyMCP guides and runtime controls`.

### Task 3 — M1: visible Chrome driver, passive observer and journal

**Files:** create `src/visible/browser-driver.ts`, `src/visible/browser-observer.ts`, `src/visible/journal.ts`, `tests/visible-browser.test.ts`, `tests/visible-journal.test.ts`; modify `src/config.ts` for opt-in mode and owned profile location. Reuse `src/chatgpt-settings.ts` and `src/dom-markdown.ts`; change them only for a demonstrated fixture defect.

**Interfaces:** consumes `BoundTurn` and `BrowserEvent`; produces `openVisibleBrowser(options: {profileDir:string; launchId:string}): Promise<VisibleBrowser>`, `submitOnce(browser: VisibleBrowser, request: {requestId:string; prompt:string; connectorId:string; model:string; effort:string}, signal: AbortSignal): Promise<{url:string; userMessageId:string}>`, `observeBoundPage(browser: VisibleBrowser, url:string, signal:AbortSignal): AsyncIterable<BrowserEvent>`. `VisibleBrowser` exposes the owned `Page` and `close()`. Journal API: `append(owner:OwnerRef,event:JournalEntry["event"]): Promise<JournalEntry>` and `replay(owner:OwnerRef,afterSequence:number): AsyncIterable<JournalEntry>`.

- [ ] Write fixtures `same_label_wrong_connector_never_sends`, `send_ack_lost_never_resends`, `equal_messages_have_distinct_ids`, `remount_does_not_replay`, `observer_cannot_submit`, `code_fence_is_only_text`, `markdown_emoji_round_trip`, `journal_sequence_survives_restart`. Assert submission count zero/one as appropriate and exact IDs/content, including persisted ambiguous sends.

  Assertion anchor for `send_ack_lost_never_resends`, after restart and reconciliation of an attempted send:
  ```ts
  expect(sendCount).toBe(1);
  expect(recoveredAttempt.state).toBe("ambiguous");
  expect(nativeExecutionCount).toBe(0);
  ```
- [ ] Run `bun test tests/visible-browser.test.ts tests/visible-journal.test.ts`; require the new cases to fail.
- [ ] Implement a persistent visible Chrome profile without imported cookies or exposed remote-control ports. Resolve the exact configured connector identity and model from rendered UI before sending; duplicate labels or missing identity fail before submission. Persist prepared/attempted/observed states. Bootstrap is 3–6 lines with real token/start instruction/user task; no JSON response contract or mandatory task file. Never choose another available model silently.
- [ ] Implement a passive observer driven by logical message IDs and rendered content. Reuse Markdown serialization, distinguish visible progress from answer, verify completion, reject missing identity/foreign navigation. The observer has no send/execute callbacks. Initial historical messages establish a baseline rather than starting native turns.
- [ ] Implement ordered private journal/receipts with mode 0600, owned directory 0700 and explicit crash checkpoints. Reopening an ambiguous attempt observes/reconciles by identity; it never sends again. Retention must not silently erase unsettled calls or evidence.
- [ ] Run fixtures and real Chrome bootstrap/guide retrieval. Demonstrate retained URL, two equal prompts with distinct IDs, remount, cancellation, manual ChatGPT submission and observation without further sends. Confirm tokens/authentication stay out of public receipts. This closes M1 only when both origin binding checks and Task 2 controls also pass.
- [ ] Commit only Task 3 paths: `feat: bind visible Chrome and journal logical conversation events`.

### Task 4 — M2: correlate real MCP calls with the native Codex owner

**Files:** create `src/visible/broker.ts`, `src/visible/broker-ipc.ts`, `tests/visible-broker.test.ts`, `tests/visible-mcp.test.ts`; modify `src/mcp/main.ts`, `src/mcp/catalog.ts` for native-owner dispatch. Preserve local sandbox dispatch as a distinct session backend.

**Interfaces:** consumes `BoundTurn`, native declarations and `Invocation`. Produces `registerNativeTurn(binding:BoundTurn, declarations:NativeDeclaration[]): Promise<{token:string; expiresAt:string}>`, `invokeNative(token:string, invocation:Invocation, signal:AbortSignal): Promise<ConnectorResult>`, `nextNativeCalls(owner:OwnerRef, signal:AbortSignal): Promise<Invocation[]>`, `acceptNativeOutput(owner:OwnerRef, callId:string, output:NativeOutput): Promise<void>`, `finishNativeTurn(owner:OwnerRef, finalText:string): Promise<void>`, `revokeNativeTurn(owner:OwnerRef, reason:string): Promise<void>`.

- [ ] Write `pending_mcp_resolves_only_after_matching_native_output`, `wrong_owner_registry_or_call_rejected`, `parallel_same_call_runs_once`, `same_id_changed_args_rejected`, `restart_does_not_redeliver_unknown_execution`, `native_unavailable_never_uses_bwrap`, `cancel_settles_pending_invocation`, `completion_waits_for_activity_fence`, `custom_patch_keeps_freeform`, `binary_result_does_not_become_fake_text_success`. Validate exact schemas and matching result kinds with the existing SDK validator.

  Assertion anchor for `parallel_same_call_runs_once`, after delivering one matching native output to two waiting retries:
  ```ts
  expect(deliveredNativeCalls).toHaveLength(1);
  expect(firstMcpResult).toEqual(secondMcpResult);
  expect(firstMcpResult.isError).toBeUndefined();
  ```
- [ ] Run `bun test tests/visible-broker.test.ts tests/visible-mcp.test.ts`; verify these cases initially fail.
- [ ] Implement private capability binding to launch/thread/turn/epoch/browser/message and native registry fingerprint. Distinguish native capabilities from existing sandbox tokens by backend, not by guessed prefixes. Prepared bootstrap capabilities become executable only after Task 3 verifies their bound message/URL. Unknown or revoked native tokens fail explicitly.
- [ ] Implement owned Unix IPC with connection authentication, restricted permissions and the frame/deadline limits demonstrated in M0. Reject symlink/foreign endpoints; do not replace them. Persist call IDs and semantic fingerprints before delivery. Concurrent retries share one result; restart replays a committed result or reports execution unknown, never reexecutes an uncertain call.
- [ ] Dispatch `codex_exec`, patch, stdin and `codex_tool_call` using exact native declarations, and preserve native policy/approval outcomes. Inventory reports the actual active native registry. Tool discovery adds only definitions returned by the matching native search result; unrelated registry replacement is rejected. Image/audio-bearing results retain their supported content or return an explicit unsupported result type, not an invented analysis.
- [ ] Settle each MCP invocation through its original RPC response after the matching native output. `codex_turn_complete` fences pending activity and releases its MCP callback before waiting for browser rendering; explicit completion text and observed final text must agree. Timeout/cancel revokes the capability and settles waiters. If a call was already delivered when its MCP deadline expires, report execution unknown/pending, retain any late native result for explicit status recovery and never claim the process was killed. Native process lifetime remains with Codex; standalone completion retains its existing local-process policy.
- [ ] Run focused tests, then real CLI and App connector canaries for nonce exec, native Begin Patch in a new scratch fixture, background stdin/EOF, tool_call, expected nonzero exit/denial and cancellation. Show native call/result transport and disk/output evidence. Close M2 only with actual Codex execution, not standalone MCP sandbox success.
- [ ] Commit only Task 4 paths: `feat: broker connector invocations through active Codex turns`.

### Task 5 — M3: progressive Responses display and continuation recovery

**Files:** create `src/visible/responses.ts`, `tests/visible-responses.test.ts`; modify `src/web-responses.ts`, `src/config.ts` to route only explicit visible sessions. Use existing parsed Responses input/identity validation; leave the legacy task-turn implementation untouched.

**Interfaces:** consumes journal events and broker calls/results. Produces `handleVisibleResponses(req:Request, body:Record<string,unknown>, deps:VisibleResponseDeps): Promise<Response>`; `VisibleResponseDeps` contains `journal`, `broker`, `browser`, `owner` and `signal`. Stream true returns a `ReadableStream` immediately after successful preflight; stream false awaits the terminal response. Mode is selected through the isolated launch receipt, not model-name inference alone.

- [ ] Write `headers_precede_final_browser_text`, `two_real_deltas_before_completion`, `matching_output_releases_original_mcp`, `retry_replays_events_not_tools`, `tool_handoff_completes_http_round_without_ending_browser_turn`, `changed_prefix_fails_without_duplication`, `cancel_unblocks_stream_and_mcp`, `unicode_markdown_final_equals_observed`. Assert ordered native event IDs/sequences and exact terminal text; test partial consumption/backpressure and connection loss.

  Assertion anchor for `two_real_deltas_before_completion`, from observer and received SSE timestamps:
  ```ts
  expect(textUpdates.filter(e => e.at < browserCompletedAt).length).toBeGreaterThanOrEqual(2);
  expect(projectedFinalMarkdown).toBe(observedFinalMarkdown);
  expect(syntheticChunkDelays).toEqual([]);
  ```
- [ ] Run `bun test tests/visible-responses.test.ts`; verify the new failure cases.
- [ ] Project observed snapshots to actual append-only text deltas, visible summary events and genuine native function/custom call events using the M0 client schema. Emit a native tool-use response promptly so Codex can execute; the next matching Responses request carries the result that resolves the still-pending MCP call. Do not hold the prior HTTP request waiting for its own tool result.
- [ ] Track browser logical identity and projection cursors across these native HTTP rounds. Already streamed text must not reappear on continuation. A changed committed prefix requires a proven native replacement event; otherwise terminate with `visible_projection_conflict`. Final aggregate text equals the final observed Markdown. Never synthesize hidden reasoning or precise unmeasured token usage.
- [ ] Journal committed call/result/display events and replay from an acknowledged cursor. A dropped native HTTP stream does not cancel or duplicate an already delivered tool by inference. Explicit native turn cancellation revokes the capability; browser close/navigation settles a typed failure. If a crash loses the execution owner, recovery is inspection/resume rather than resend.
- [ ] Run fixtures, then capture a real answer with at least two browser text updates before completion, timestamp-correlated SSE updates in both clients, Markdown/code blocks and a tool boundary. Run reconnect/cancel controls; compare final text exactly and report first-visible-text separately from total duration. No claimed fixed latency improvement.
- [ ] Commit only Task 5 paths: `feat: stream visible browser events through native Responses`.

### Task 6 — M4: both entry routes in guided CLI and App

**Files:** create `src/visible/coordinator.ts`, `tests/visible-coordinator.test.ts`; modify `src/codex-conversation.ts`, `src/codex-app.ts`, `src/isymcp.ts`, `src/menu.ts`, `src/visible/connector-control.ts`; extend `tests/codex-conversation.test.ts`, `tests/codex-launcher.test.ts`, `tests/menu.test.ts`. Add opt-in native client skill packaging through existing launcher profile configuration, after verifying its installed invocation syntax.

**Interfaces:** consumes all previous contracts. Produces `openConversation(input:{grant:string; client:ClientKind; entry:EntryKind; requestId:string; launchId?:string; conversationUrl?:string}): Promise<VisibleReceipt>`, `ingestBrowserUser(receipt:VisibleReceipt,event:Extract<BrowserEvent,{kind:"user"}>): Promise<OwnerRef>`, `cancelConversation(launchId:string,turnId:string): Promise<void>`, `resumeConversation(launchId:string): Promise<VisibleReceipt>`. `VisibleReceipt` has version `isymcp-visible-conversation/1`, entry/client/launch/thread/canonical URL/profile reference and `state: "binding" | "ready" | "blocked"`; no token. Existing v1 receipts remain readable without silent migration.

- [ ] Write `codex_entry_sends_one_bootstrap`, `browser_entry_records_original_user_without_resend`, `same_prompt_twice_is_two_turns`, `remount_is_zero_new_turns`, `same_request_returns_same_launch`, `two_launches_never_share_context`, `app_writer_unavailable_is_blocked`, `native_config_unchanged`, `resume_requires_exact_id`. Test all menu actions with temporary homes, no account calls.

  Assertion anchor for `browser_entry_records_original_user_without_resend`:
  ```ts
  expect(createdNativeTurns).toHaveLength(1);
  expect(createdNativeTurns[0].input.text).toBe(observedUser.text);
  expect(browserDriverSendCount).toBe(0);
  expect(globalConfigAfter).toBe(globalConfigBefore);
  ```
- [ ] Run `bun test tests/visible-coordinator.test.ts tests/codex-conversation.test.ts tests/codex-launcher.test.ts tests/menu.test.ts` and confirm the new cases fail before code.
- [ ] Implement the coordinator. Codex-origin turns reuse the active native request and submit once in its retained Chrome conversation. Browser-origin turns use verified source metadata or explicit guided URL/tab binding, then `HostContract.openThread` for a new grant-bound thread and `startTurn` with the actual user text/message ID. Exclude the bootstrap/control handshake from duplicate user history. If already owned by a Codex-origin request, acknowledge its matching browser echo rather than start another turn.
- [ ] Refresh capabilities per native turn without replaying an old token. Codex-origin submission includes the fresh short turn bootstrap. For ChatGPT-origin input, authorized `isymcp_capabilities` returns the current capability only after the source page/message and session grant are verified. The guide teaches that lookup before `codex_turn_start`; stale tokens remain rejected. Test `new_turn_gets_new_capability` and `old_token_cannot_execute_next_turn` with two otherwise equal prompts.
- [ ] Bind `.com` controls to the coordinator; remove the Task 2 unavailable outcome only when the corresponding adapter actually works. No grant opens a local chooser/request receipt; it does not adopt a remotely supplied workspace. Verify real connector schema refresh so published controls are actually invocable.
- [ ] Add `isymcp conversation new --mode visible --client cli|app --cwd <authorized-dir> --model <verified-alias>` plus exact-ID resume, and menu label `Conversación en Chrome…`. Existing command without `--mode visible` preserves current behavior. Add `isymcp control up|status` for local recovery when the remote tunnel is fully offline; no automatic launch at every native chat startup.
- [ ] Launch CLI using per-process configuration and App using its isolated profile. Use the proven HTTP Responses streaming transport in those profiles; do not redirect native-model traffic or change global WebSocket/HTTP preferences. Skill installation stays inside the chosen profile; publish no universal slash command until actually tested. Status exposes binding, pending tool, approval, stopped daemon/client and unknown tunnel states. Foreign App/thread ownership remains a blocker instead of evicting another writer.
- [ ] Run three real turns, tool execution, cancel and exact resume for each of the four client/origin combinations. Exercise duplicate start, daemon off, isolated App off, control off and offline tunnel. Confirm global config hash/semantic state unchanged and a separate native-model session still works. Attach real native/browser IDs to each receipt.
- [ ] Commit only Task 6 paths: `feat: guide Chrome conversations from Codex and ChatGPT entries`.

### Task 7 — M5: close evidence, regressions and the human guide

**Files:** create `scripts/e2e-visible-chrome.ts`, `tests/visible-acceptance.test.ts`, `docs/verification/2026-10-11-visible-chrome.md`; modify `GUIA.md`, `README.md`. Create a public sanitized evidence manifest under `docs/evidence/` referencing immutable private raw receipts, without copying their secrets.

**Interfaces:** consumes committed receipts and previous runtime APIs. Produces `runVisibleCanary(options:{client:ClientKind; entry:EntryKind; evidenceDir:string; signal:AbortSignal}): Promise<CanaryReceipt>`. `CanaryReceipt` records command/env/version, stage outcomes, IDs, timestamped actual events, final equality, hashes and explicit unsupported/blocking reasons. Independent outcomes are never collapsed into a single optimistic status.

- [ ] Write `acceptance_requires_four_distinct_paths`, `stream_claim_requires_precompletion_updates`, `native_claim_requires_correlated_executor`, `public_manifest_contains_no_tokens`, `failed_receipt_is_retained`. Test acceptance against forged/missing evidence: screenshots/final text alone cannot pass.

  Assertion anchor for `acceptance_requires_four_distinct_paths` on complete final receipts:
  ```ts
  expect(new Set(receipts.map(r => `${r.client}/${r.entry}`)).size).toBe(4);
  expect(receipts.every(r => r.finalEqual)).toBe(true);
  expect(missingNativeOutputAccepted).toBe(false);
  ```
- [ ] Run `bun test tests/visible-acceptance.test.ts`; confirm these negative controls initially fail.
- [ ] Implement an opt-in bounded canary runner. Each run creates fresh private evidence paths and owned scratch fixtures; account login remains visible. The runner never kills user sessions or cleans arbitrary directories. Enforce M0 limits and save partial failures before exit. Do not overwrite earlier red runs.
- [ ] Run focused visible tests plus existing native/legacy/media/isolation regressions. Then run `bun test` once on the final code and preserve raw stdout/stderr, exit code and SHA-256. CI uses hermetic fixtures; real account/tunnel acceptance is separately dated. Repeat only if changes or unresolved failures justify it.
- [ ] Run `bun run scripts/e2e-visible-chrome.ts --client cli --entry codex`, then its `app/codex`, `cli/chatgpt`, `app/chatgpt` variants on the final commit. Preserve denied/nonzero/cancel/reconnect evidence and verify the final GUI display against actual journal/native results.
- [ ] Request an independent whole-branch review focused on writer ownership, token/scope boundaries, duplicate execution, streaming and cancellation. Fix concrete findings, rerun their affected tests/canaries and retain previous results. No delegation until the selected execution method authorizes it.
- [ ] Write Spanish `GUIA.md` with the one launch command first, actual outputs, status/action table, local offline recovery, connector refresh, explicit single-writer rule and separate native/standalone/legacy routes. README summarizes only demonstrated behavior and limits, including sampled frames versus exhaustive video and acoustic measurements versus listening. Attribute any imported MIT reference code.
- [ ] Commit only Task 7 paths: `docs: verify visible Chrome CLI and App acceptance`. Send the bridge RESULT and release its lease after committing. Report exact demonstrated gates and any remaining `NOT_DEMONSTRATED`; do not claim headless or universal service stability.

## Self-review and handoff

Coverage: spec components map to Tasks 2–6; input/ownership/source identity to 1 and 6; all five Review Focus cases have named tests; M0–M5 each have a live advancement gate. Tool/result interfaces remain distinct from DOM observation and standalone sandbox execution. Task 2's public open tool is explicitly unavailable until Task 6, avoiding advertising implementation as runtime truth.

This is a proposed written plan, not completed work. All implementation steps remain unchecked. The next action is user review of this plan and execution method. Preserve the approved Chrome-first scope and milestone order; do not start headless or unrelated module implementations during these tasks.
