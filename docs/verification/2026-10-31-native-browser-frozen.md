# Native-browser autonomous mode frozen for 1.0.0 — 2026-10-31

Status: **FROZEN by owner decision**. This record documents a product and
compliance decision; it does not claim a new E2E success.

## Decision

The account owner selected the recommended option: freeze the autonomous
native-browser line for 1.0.0 instead of resuming remote tests.

- Both native modes remain blocked: `isymcp native-browser status --json`
  reports `ready:false`, `phase:capability-gate`, with `codex` blocked by
  `native_browser_general_owner_adapter_unverified` and `autonomous` blocked by
  `native_browser_external_control_unverified`.
- The entrypoints keep returning `503 native_browser_unavailable` before
  dispatch. There is no fallback to the visible Chrome adapter.
- No new permissions, owner adapter, pair registry, process dispatch or
  concurrency are authorized.
- No remote retry follows a reported OpenAI safety block. The block observed on
  2026-10-23 is preserved as reported evidence; it is not relabelled or
  diagnosed remotely.
- The line can only be revisited if a documented, authorized owner/browser
  adapter becomes available and the owner makes a new explicit decision.

## Why

The 2026-10-23 records show one real native execution leg (exit 0, confirmed in
the app thread), but the MCP return leg failed and ChatGPT subsequently reported
an OpenAI safety block on closure. The capability gate record states that a
complete E2E requires an authorized owner adapter that can service MCP calls
while independently observing its explicitly bound tab; that adapter does not
exist. `docs/compliance/FINAL_VERDICT.md` classifies automated consumer-web UI
operation and retries against safety blocks as `DENY`, with account loss listed
as a critical risk.

## Consequences

- Autonomous native browser control is unavailable in 1.0.0. Users keep the
  human-operated visible browser, the conditional Custom MCP App flow and the
  local Codex CLI provider with sandboxing.
- The failures, evidence and capability matrix remain published; nothing is
  deleted or rewritten.
- The owner accepted the compliance verdict
  (`docs/compliance/FINAL_VERDICT.md`) in the same decision round.

## References

- Capability gate: [2026-10-23-native-browser-gate.md](2026-10-23-native-browser-gate.md)
- Partial native proof and retained failures:
  [2026-10-23-current-owner-browser.md](2026-10-23-current-owner-browser.md)
- Execution ledger:
  [2026-10-23-native-browser-progress.md](../superpowers/plans/2026-10-23-native-browser-progress.md)
- Compliance verdict: [FINAL_VERDICT.md](../compliance/FINAL_VERDICT.md)
