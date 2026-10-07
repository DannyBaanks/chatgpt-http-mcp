# Codex Web task turn — implementation plan (M8–M9)

Approved design: docs/CODEX_WEB_BACKEND_DESIGN.md. Danny asked to continue implementation directly on 2026-10-07. Execute inline with TDD and a final independent review.

Goal: one real text Web model, task-bound conversation and fail-closed composer verification. No live Codex configuration/auth edits and no tool execution by ISyMCP in this path.

1. Red tests: identity required/conflicts rejected; A/B/A/B distinct canonical URLs; transcript prefix checked; replay returns same response; same turn different input rejected; ambiguous submit blocks new turns/restarts; visible selection mismatch never submits.
2. Add responses/task-turn.ts: durable private per-task state, atomic writes, exclusive per-task file lease, request fingerprint and prepared/attempted/completed states. Fail closed on stale lease after crash; never automatically reclaim it. Resolve observed thread/session/turn metadata consistently. One request per turn in this text-only delivery; M10 later needs observed request sequencing.
3. Add responses/selection.ts: accept only chatgpt-web/gpt-5.6-sol with high (default high), verify exact visible GPT-5.6 Sol / High / 3-of-3 under browser lock, return typed mismatch before submit. Do not automatically change settings.
4. Browser hooks: beforeSubmit runs after navigation/settle inside lock; onSubmitAttempt durably records uncertainty before clicking; submitOnce prevents retries. connector empty explicitly disables connector inheritance. Other paths retain defaults.
5. HTTP and WS share task backend; WS retains upgrade identity headers and full response.create body. Native paths stay unchanged. Web compaction returns explicit unsupported error. Catalog stops advertising images until transport exists.
6. Verification: targeted unit/transport tests, full suite, real Responses A/B/A/B canary, then installed Codex CLI through temporary custom provider. Record CLI success separately from Codex App E2E; do not claim App selector integration. Real/model failures retain evidence and block gate advancement.
7. Document private state, recovery limits and observed capabilities. Create PR, attach and verify CI. No merge without Danny's request.

Delta contract: initial input is complete structured state; next input must start with the previously committed normalized input plus the actual assistant answer. Compare roles/text, not transport-only IDs. Changed instructions/prefix returns context mismatch. No implicit delta mode, compaction or invented replay.

Persistence: raw task transcript and answer are local private state (0700 directory/0600 files), never repository evidence. Public evidence contains controlled nonces and sanitized metadata only. A leftover lease or attempted request requires manual investigation, not blind replay.
