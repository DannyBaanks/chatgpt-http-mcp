# Chrome access recovery — 2026-10-14

The user reported that Google also rejected manual login in the normal Chrome
window using our owned profile. Do not treat the manual-profile workaround as
successful. No authentication/cookie import or browser-security bypass was used.
The owned browser controller was stopped after checking its exact command line.

Opened official Chrome normally with the user's existing profile. The extension
initially returned `Unable to load browser request-header policy` twice. After
the user reconnected the extension, its actual tab became available. Visible
ChatGPT account UI showed an existing signed-in session. The model menu showed
GPT-6 checked and Medium (2 of 3); attaching the actual connector yielded
`app://asdk_app_6ace90ad54848191912160b8880294c7`.
No message was sent and the user's draft was retained.

Private screenshot:
`/home/danny/.codex-web-http/canaries/chrome-session-restored-20261014.png`
SHA-256 `d4d826e2004092009815ad73e43ba62caff86f022ba9cf870b56f873f28d2341`.
This is access/attachment evidence, not a new MCP execution receipt.

Two driver faults were isolated and repaired:

- Fresh chat inspection waited for a nonexistent app mention. Count mentions
  before reading; zero means unattached, multiple means ambiguous.
- The effort chooser now shows a generic caption. Read the actual selected
  effort from the model menu's status instead of inferring it from that caption.

Regression evidence, all paths under
`/home/danny/.codex-web-http/canaries/`:

| File | Outcome | SHA-256 |
| --- | --- | --- |
| visible-driver-empty-mention-red-20261014.txt | Expected failing regression | 5ecb777ab47f9144abea15f05e2864ba049277372aeb9d2e01d80ec08c280bbf |
| visible-driver-effort-red-20261014.txt | Expected failing regression | e721a5c726e5d242ea5e1a5c5affd728311a0e0a03ce94baf2069db08ecb1709 |
| visible-driver-final-green-20261014.txt | 7 pass, 0 fail, exit 0 | 0eecd3edb40b8a7c05df2401ffee61c1c889c1ed2da481727b0bdb5e4affa697 |

Actual command: `bun test tests/visible-driver.test.ts tests/visible-browser-worker.test.ts`.

Final full suite: `bun test`, exit 0, 535 pass, 1 skip, 0 fail; 536 tests
across 78 files. Raw file `visible-driver-suite-20261014.txt` in the same private
directory; SHA-256 `a8058f703eb61389e37c8c76593b667d7c60e02ba0d1d7e406db0f9f2cbf4eb7`.

Current global configuration was inspected, not edited: model `gpt-6-luna`,
default provider, no global `openai_base_url`. Its current SHA-256 is
`968b2c1c4945098513df181bcd14340273cf900d4eef62fab22f57208a730a86`;
it differs from older receipts, so byte-for-byte historical equality is not claimed.

Limits: the ordinary Chrome extension session does not automatically become a
standalone persistent browser-worker session. Owned-profile authenticated reuse,
production coordinator integration and the complete conversational acceptance
matrix remain NOT_DEMONSTRATED. No live gate is closed by this recovery.
