# Codex Responses input fidelity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Preserve Codex Responses text, roles and tool declarations without silently discarding unsupported input.

**Architecture:** A pure Responses parser separates text messages from tool declarations. HTTP and WebSocket use this parser and return typed validation errors before touching the browser. The local chat and Chat Completions contract stay separate.

**Tech Stack:** Bun 1.4.2, TypeScript, bun:test; installed Codex CLI 0.160.0 for contract fixtures.

**Spec:** ../../CODEX_WEB_BACKEND_DESIGN.md (approved by Danny on 2026-10-07).

## Global Constraints

- GPT.com proposes; Codex remains the tool executor and authority boundary.
- No Electron, auth changes, live Codex configuration changes, cache deletion, or reference-journal edits.
- Do not advertise or implement the native tool loop in this input-only delivery.
- Preserve roles and ordering; user content never becomes system authority.
- Unknown content cannot disappear silently. Existing string input remains exact.
- Commit only explicit owned paths; keep raw red/green evidence and SHA-256.

## Review Focus

- Mixed text/image input must fail completely, rather than submit only its text.
- Malformed parts or unsupported result items must fail before browser submission.
- A valid user-only HTTP request must reach the adapter with the complete prompt.
- Namespace/custom declarations must remain separate from user text, in original order.
- HTTP and WebSocket must agree on validation, and native passthrough must remain intact.

---

### Task 1: Lock the input bug with a red witness

**Files:** Test `tests/web-responses.test.ts`, create `tests/responses-input.test.ts`.

**Interfaces:** Existing `extractPrompt(body: Record<string, unknown>): string` and `peekWebRequest(req: Request)` are the observable boundaries.

- [x] Add `user_only_is_preserved`: message user + input_text M7_USER_NONCE must produce nonempty text containing M7_USER_NONCE.
- [x] Add tests for instructions before user text, roles/order, exact string input, multiple text parts and direct input_text.
- [x] Add negative mixed image, malformed text, unknown item and unsupported function/custom result tests, expecting named errors.
- [x] Add additional_tools fixture based on the observed Codex namespace/custom declarations, asserting declarations stay separate and ordered.
- [x] Run `bun test tests/responses-input.test.ts tests/web-responses.test.ts`; preserve raw failing log and exit status.

### Task 2: Implement the pure parser

**Files:** Create `src/responses/input.ts`; modify `src/web-responses.ts`.

**Interfaces:** `parseResponsesInput(body: Record<string, unknown>): ParsedResponsesInput`; `ParsedResponsesInput = { prompt: string; declarations: Record<string, unknown>[] }`; `ResponsesInputError extends Error` carries `type` and HTTP `status=400`.

- [x] Validate input string or array and instructions string; do not coerce malformed input.
- [x] Preserve message roles user/assistant/developer/system using explicit role labels for structured input; keep standalone string exact when instructions absent.
- [x] Accept textual input_text/output_text with string text. Reject image and unknown parts with `web_unsupported_input`; reject malformed objects with `web_invalid_input`.
- [x] Keep additional_tools.tools declarations separate; validate their container without claiming execution support. Reject unsupported tool/result items until the later native-loop plan.
- [x] Return `web_empty_input` for no usable message text, including declarations-only input; instructions alone do not fabricate a user turn.
- [x] Delegate extractPrompt to the parser and retain declarations in WebRequest for future transport; do not change Chat Completions.
- [x] Run the targeted tests; preserve passing log. Commit parser and tests with explicit paths.

### Task 3: Propagate errors consistently at transport boundaries

**Files:** Modify `src/server.ts`, `src/ws-responses.ts`; test `tests/ws-responses.test.ts` and `tests/responses-input.test.ts`.

**Interfaces:** HTTP Web requests catch ResponsesInputError and return `{error:{type,message}}` with 400. WebSocket error events contain the same type/message, without submitting an empty/partial prompt. Non-Web HTTP requests retain native forwarding; native WebSocket rejection retains the existing behavior and does not gain browser routing.

- [x] Test the real HTTP handler with image+text and invalid input; it must return a typed 400 without needing browser state.
- [x] Test valid structured WebSocket user input and malformed input; native model requests remain outside this parser's Web-only validation.
- [x] Apply matching HTTP/WebSocket handling. Parse errors do not fall through to native upstream or become generic 500.
- [x] Run `bun test tests/responses-input.test.ts tests/web-responses.test.ts tests/ws-responses.test.ts tests/passthrough.test.ts tests/chat-completions.test.ts`.
- [x] Commit transport handling with explicit paths.

### Task 4: Verify and publish the narrow claim

**Files:** Update `docs/CODEX_WEB_BACKEND_DESIGN.md`; create a uniquely named evidence manifest under `docs/evidence/` referencing raw red/green outputs and hashes.

- [x] Run `bun test` once, `git diff --check`, and inspect status/diff for unexpected paths.
- [x] Record M7 parser fidelity as demonstrated by tests; do not upgrade text App E2E, task isolation, tools, model enforcement or streaming.
- [x] Publish one focused PR for M7 and attach it to this chat. Record actual CI result; no merge without the requested authorization.

## Next delivery dependencies

M8–M9 follows only after this delivery: task binding using observed thread/session/turn metadata, persistent submit ledger, fresh/canonical conversation navigation, connector explicitly disabled, and composer-model/effort preflight under the browser lock. Real A/B/A/B canary is its gate.

M10 follows that gate: capture a controlled call/result using the installed Codex client; adapt exactly its custom/namespace representation; correlate pending calls and results; validate retries and effects. Codex App E2E remains a separate publication gate, never inferred from CLI fixtures.

M11–M19 stay in the approved design and receive concrete plans after their prerequisite contracts are observed. No speculative serializers or installation changes in M7.
