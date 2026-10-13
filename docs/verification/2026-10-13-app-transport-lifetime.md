# App probe transport lifetime — 2026-10-13

## Scope

The optional probe uses the actual Desktop App writer and a private Responses endpoint. It does not turn the bridge into an Electron application, modify global provider configuration, copy credentials, or certify a general conversational provider.

## Failure observed and repair

The live App attempt in `active-app-20261013-relaunch-02` accepted a native turn and waited for Chrome. The remote tunnel was stopped; Chrome initially returned `Session terminated`. After restarting that same tunnel, real `media_list` returned five records and native start/inventory succeeded. The App response connection had already closed. Delivering the native call threw `ERR_INVALID_STATE: Controller is already closed`; no correlated native command result was obtained. This remains a failed live execution attempt, not a pass.

`appProbeStream` now tracks transport lifetime explicitly: HTTP abort, stream cancellation, or a failed enqueue closes the transport once; it clears heartbeats and blocks late tool delivery. The probe immediately revokes its native capability and owner when its App turn disconnects, then preserves failure evidence. It never resubmits. Auxiliary title responses do not own or revoke the native turn. Abort checks fence asynchronous registration/minting. Normal SSE completion does not revoke the owner because the subsequent native tool-result request must still be allowed.

App launch stderr uses a file descriptor rather than a referenced pipe, so an optional detached App window cannot keep the finished receiver alive through its stderr listener.

## Verification

RED: two new cancellation tests failed because the stream lifecycle function was absent. GREEN: focused command `bun test tests/no-electron-dep.test.ts tests/active-native-app.test.ts tests/active-native-mcp.test.ts` returned 16 pass, zero failures. This includes real Bun HTTP client abort, reader cancellation, normal completion, late delivery refusal and existing disconnected-owner routing controls.

The first full run returned 515 pass, one skip and one failure: the static no-Electron rule did not recognize the two optional App-only probe surfaces. Its allowlist now names those exact files; dependency prohibition remains intact. Final full-suite result is recorded below after completion.

## Separate native lifecycle evidence

`scripts/probe-native-lifecycle.ts` verified one installed CLI writer interrupted while awaiting its local deterministic provider, then resumed the exact persisted thread `01a13555-b275-7890-b510-bd38f6d8a8f2`. Interrupted status was `interrupted`; resumed turn completed; two provider requests. This demonstrates that narrow CLI lifecycle, not cancellation of a running native process, an MCP call, Chrome, or the App.

## NOT_DEMONSTRATED

The repaired real Chrome → ISyMCP → App command/result loop awaits a new user marker. General multi-turn provider behavior, unattended binding, broad native coding tools, streaming reasoning and App cancellation/resumption remain open. M0 remains OPEN; no claim of 100% completion. Review is author-only per the user's solo-work instruction.

## Private raw evidence hashes

- `app-disconnect-red-20261013.txt`: `457e43f31231ea978499c4c434ca81781fbb656d5a8db1e596d3cdbc5b4cc03b`
- `app-disconnect-focused-20261013.txt`: `3ec4ae6e11df89bd7844659b03ba982a7429c6dee9fe236ec63e95962a42a212`
- `app-disconnect-suite-20261013.txt`: `4b861288abd90e0bf5bfcf16177e657c39d7459ce0b894a57c2d07445b86cbb5`
- `active-app-20261013-relaunch-02/failure.json`: `faeaf906fc2e897c6e88c71eee64d06e1cbc6ffbc322833225299f268816821b`
- `native-lifecycle-20261013-01/receipt.json`: `a07ffc00b7ba5f7eeebc24db5746a4678387a48c6977d8530c529f96659fae58`

Final `bun test`: **516 pass, 1 skip, 0 fail**, 517 tests across 73 files, exit 0. Raw final suite SHA-256: `ce2e4f4a86cf1863cc90e07752c48aa51bb3c67b2dc13a08887da60f5a7ae39d`. `git diff --check` returned exit 0.

## Exact bold-marker regression

The live App rejected request contained exactly `**ISYMCP_APP_CANARY_20261013**` followed by a newline. It was a formatting mismatch, not evidence of network failure. The gate now permits exactly three representations: literal marker, whole inline-code marker, whole bold marker. Extra words inside or outside the wrapper still reject. RED: new regression failed with `native_app_marker_mismatch` (raw SHA-256 `9386938cd951e2277889c6e69df1860cb66f2852dea7538dae0765a5b1cc7111`). GREEN: App plus active-native tests returned 14 pass, zero failures (raw SHA-256 `48fca2eca76184227c9d5669cc32903bc35ed370d45ae81e51c5c929f3bba582`). No new full-suite claim. Fresh receiver reused the open App after stopping only the previous unused receiver. Live corrected App execution remains NOT_DEMONSTRATED until its callback/result is captured.
