# Visible Chrome E2E checkpoint — 14 October 2026

## Result

The Chrome host started from the isolated profile `d946b5e9-231e-4b13-83ce-5170cf353658` and attached only to its own loopback CDP endpoint and unique local landing page. The browser then showed the Cloudflare human-verification screen. The user confirmed twice that it remained blocked. The browser worker inspection timed out while that page was active. No connector was selected, no compose was submitted, and no native call or response was produced.

The host status `browser_ready_auth_unverified` describes process startup only. It is not evidence that ChatGPT loaded or that the account is authenticated.

## Changes and checks

- The driver now detects the visible Cloudflare challenge before reading, preparing, or sending a chat and returns `visible_challenge_requires_human`.
- Shutdown now asks the owned Chrome process to close through its own CDP `Browser.close` command, then waits for that exact process. A SIGTERM is a bounded fallback. The previous direct termination produced Chrome's “didn't shut down correctly” restore prompt.
- Focused test command: `bun test tests/visible-browser-host.test.ts tests/visible-driver.test.ts`.
- Result: 10 passed, 0 failed, 31 assertions; exit code 0.
- Raw output: `/home/danny/.codex-web-http/canaries/visible-chrome-human-challenge-d7a18faeb86e4fed9b05f299fdafb0a3.txt`.
- Raw output SHA-256: `f29a8e6f262f3aa8717ee747510dd1b4c7b7781254cdb65d6e716fcdca119505`.

## Claim status

| Claim | Status |
|---|---|
| Owned normal Chrome process and loopback CDP selection | DEMONSTRATED in this launch |
| Model and effort inspection | DEMONSTRATED before the browser process exited: GPT-6, medium |
| Challenge detection in the driver | DEMONSTRATED by focused fixture test |
| Clean real Chrome shutdown after the new change | NOT_DEMONSTRATED; only fixture tests have run |
| Connector invocation from this host | NOT_DEMONSTRATED |
| Browser-to-native MCP tool round trip from this host | NOT_DEMONSTRATED |
| Full visible conversation E2E | NOT_DEMONSTRATED |

The next live attempt can continue only after the user completes the human verification and ChatGPT loads. No automated CAPTCHA solving, challenge bypass, or resubmission is part of the implementation. M0 remains open; M1–M5 remain uncertified. The user requested that headless work wait until the visible E2E is complete.
