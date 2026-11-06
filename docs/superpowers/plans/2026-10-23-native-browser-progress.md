# ISyMCP native-browser E2E — execution ledger

Plan: user-approved five-milestone plan in this chat, 2026-10-23.
Working branch: `codex/native-browser-e2e`, reusing the existing isolated worktree.

- Milestone 1: capability diagnostics implemented; live integrated-browser navigation, submission and one native execution demonstrated. Complete MCP return and autonomous control remain unverified/blocked.
- Milestones 2–4: gated, not implemented. No pair registry, expanded native grants, process dispatch or concurrency is advertised.
- Milestone 5: entrypoint/probe regression tests implemented; complete E2E acceptance remains unverified.
- Ruling: stop at the capability gate rather than invent an externally callable browser API — required by the approved plan — cost: the full system remains incomplete.
- Ruling: report both modes blocked at the product entrypoints until a real owner/browser adapter exists — browser control by this conversational agent alone does not register a native execution owner — cost: no native launch is available through ISyMCP yet.
- Ruling: preserve existing execution backends and queues — expanding them before the gate passes would violate the milestone dependency — cost: two-pair parallel execution remains deferred.
- Baseline: 651 pass, 3 skip, 2 existing timeouts. Four new entrypoint tests RED → GREEN. Six additional boundary/probe tests passed.
- Final verification: typecheck passed; full suite 663 pass, 3 skip, 0 fail (666 tests / 101 files). The baseline timeouts did not recur. Independent review: no actionable findings. Diff whitespace check passed.

Evidence and remaining acceptance: `docs/verification/2026-10-23-native-browser-gate.md`.

## Follow-up: current-owner fixed canary

- Implemented an agent-mediated fixed-command grant that discloses the actual full-access host; it does not grant arbitrary execution. Broker and route both enforce the command.
- Observed and bound real browser message identity; start/inventory completed through the real MCP connector.
- One actual native command completed (exit 0), independently verified against the app's current thread/turn and execution item. Its result did not complete the MCP return leg.
- Fixed a 0644→0600 result-publication race with atomic, private, non-replacing publication. Added a regression test.
- Fixed session cleanup on rejected owner claims; canonical workspace identity; prompt controller cancellation after delivery. Each regression was observed failing and then passing.
- Ruling: use a fixed diagnostic grant rather than label this full-access host read-only — cost: general commands remain unavailable, but the canary cannot widen access to files or arbitrary commands.
- Ruling: preserve the native success and MCP transport failure as separate evidence — cost: the full E2E remains incomplete; no success is inferred from a printed marker alone.
- Ruling: halt remote activity after ChatGPT reported an OpenAI safety block on closure, and revoke the unsent next grant — cost: no live retry of the corrected local publication path or later milestones in this run.
- Detailed evidence: `docs/verification/2026-10-23-current-owner-browser.md` and `2026-10-23-current-owner-native-record.json`.
- Independent follow-up review identified canonical-cwd mismatch and cancellation waiting indefinitely after delivery; both fixed with failing-then-passing regression tests.
- Follow-up verification: `bun run typecheck` passed; `bun test` completed with 670 pass, 3 skip, 0 fail (673 tests across 103 files). `git diff --check` passed.

## Ruling 2026-10-31: frozen for 1.0.0

- The account owner accepted the compliance verdict and chose to freeze the
  autonomous native-browser line instead of resuming remote tests. No new
  permissions, owner adapter, pair registry or concurrency are authorized.
- The capability gate remains in code: `native-browser status` reports
  `ready:false` with both modes blocked, and the entrypoints keep returning
  `503 native_browser_unavailable`. No remote retry follows a reported OpenAI
  safety block.
- Revisiting this line requires a documented, authorized owner/browser adapter
  and a new explicit owner decision. Trade-off: autonomous native control is
  unavailable in 1.0.0; account risk is not increased.
- Decision record:
  `docs/verification/2026-10-31-native-browser-frozen.md`.
