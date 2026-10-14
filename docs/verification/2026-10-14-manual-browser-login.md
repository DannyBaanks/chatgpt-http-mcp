# Manual authentication before browser automation

The visible launcher now opens official Chrome normally before attaching any
Playwright context. New launches require this step; an existing launch can
request it explicitly with `--login`. The user closes that dedicated window
after authentication. A nonzero exit or interrupted browser rejects the handoff.
Closing the window does not prove authentication; runtime state remains
`browser_ready_auth_unverified` until separately verified.

Both stages use the same owned profile and launch ID. Foreign profiles are
refused before browser launch. No cookies, credentials or storage state are
exported/imported. The automated stage excludes Playwright's
`--password-store=basic` and `--use-mock-keychain` defaults so that it continues
using the system credential store. Automation identification is not suppressed.

Reference inspected: local checkout of `miuuyy/codex-chatgpt-web`,
`src/browser-login.ts:385–406`; the login file matches reference commit
`b6ca2d3f91f8a2ba140b522fe3b3c50b4ebffa2d`. This adapts the normal-Chrome
login ordering and credential-store configuration, not the Electron browser host
or its storage-state export. No authentication guarantee is inferred from that
reference.

Executed command from the implementation checkout:
`bun run scripts/start-visible-browser.ts --login`.
Fresh launch `d946b5e9-231e-4b13-83ce-5170cf353658` reported
`waiting_for_manual_login`. The owned normal Chrome process was observed without
automation, debugging or basic-password-store flags. Private evidence:
`/home/danny/.codex-web-http/visible/d946b5e9-231e-4b13-83ce-5170cf353658/manual-launch-evidence.json`,
SHA-256 `e93af46cd172ad30c0999d0b2a733951d7cb58d577f84b0bf84a45e356db1141`.
The user then reported successful account login in that exact normal Chrome
window. This is user-reported manual-login success; reuse by automation remains
NOT_DEMONSTRATED while the normal window is still open. No conversation or coding
request was sent.

Focused command:
`bun test tests/visible-login.test.ts tests/visible-driver.test.ts tests/visible-browser-worker.test.ts`,
exit 0, 10 pass, 0 fail. Raw green evidence:
`/home/danny/.codex-web-http/canaries/visible-manual-login-green-20261014.txt`,
SHA-256 `3755604ee89300fe52f930cec71656ff425e6e4a1f851f1a4b7b4169a3f577f5`.
Expected preimplementation failure retained at
`/home/danny/.codex-web-http/canaries/visible-manual-login-red-20261014.txt`,
SHA-256 `0309e1a6788afe391176d8387d437bfc0155fe0e0fbdba0be1e47008661047cf`.

Final `bun test`: exit 0, 538 pass, 1 skip, 0 fail; 539 tests across 79 files.
Raw output `/home/danny/.codex-web-http/canaries/visible-manual-login-suite-20261014.txt`,
SHA-256 `e1f706a2b616f4937851e47cc70c4083863f58afc3283cb314c9e8c417104ebd`.
