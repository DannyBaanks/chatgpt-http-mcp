# Conversational Web tasks with native Codex execution

Approved scope: a new Codex task selects GPT-5.6 Web, creates a ChatGPT
conversation automatically, and keeps it bound across native tool calls and
later user turns. CLI and Codex App have independent verification gates.
Codex remains the executor and owner of permissions, sandbox and approvals.

### Task 1: Observe the installed client contract

Capture a controlled call and result using the installed Codex client and a
temporary local Responses provider. Preserve raw requests privately and hash
them. Do not change user configuration or authentication. Gate: the native
command actually runs and its stdout returns in the next request.

### Task 2: Complete the native tool round trip

Use the exact supplied function/custom/namespace declarations. Send a bounded
tool directory plus schemas to Web; request remaining schemas on demand.
Decode one strict final answer or one tool call at a time, validate the exact
name and arguments, emit native Responses items and matching SSE/WS events.
Accept only results correlated to the pending call in the same task/turn.
Persist each request independently so replay does not resubmit Web or invent
new call IDs. Preserve text behavior, role order, private state and ambiguous
submit guards. Gate: RED/GREEN tests for sequential calls, replay, wrong task,
wrong ID/type, changed context/registry, malformed reply, denial/nonzero and
new user turns; real CLI canary through Web. No execution inside the adapter.

### Task 3: Add the guided new conversation entry

Expose New Codex conversation in the TUI and CLI, selecting CLI or App and
workspace. Use a per-process local Responses provider for CLI. Preserve the
normal native launcher and existing user configuration. Save/list the actual
Codex thread and canonical ChatGPT URL after the first verified turn. App
launch/resume must use the observed installed client contract; fail explicitly
when it is unavailable. Gate: CLI startup/resume and App verification measured
independently, with native commands owned by Codex.

### Task 4: Verify and document the usable result

Run the full suite, live CLI and available App canaries. Preserve SHA-256 and
negative results, distinguish app-server protocol from desktop UI evidence.
Update GUIA.md and README with executed commands and concrete limitations.
Conduct one fresh branch review, fix significant findings with regression
tests, commit only the task paths. Do not delete earlier evidence/workspaces.

## Preflight decisions

- Current baseline is a linked worktree, branch codex/guided-video-cli.
- Installed Codex 0.162.0 sends function declarations in tools and returns
  function_call_output. Older additional_tools/custom declarations remain
  supported only as explicit types; unknown inputs fail before submission.
- The existing one-request-per-turn ledger must become a per-request ledger
  with a pending native call; replay still returns the original response.
- Large connector registries cannot be pasted wholesale: names are indexed
  and exact schemas requested on demand; no unannounced omission.
- Baseline E2E smoke exceeds its five-second test budget in harness detection.
  Measure the cause and give that integration test an appropriate bounded
  budget without weakening its assertions.
- No milestone is complete until its executable gate has passed. Unavailable
  desktop GUI evidence remains NOT_DEMONSTRATED.
