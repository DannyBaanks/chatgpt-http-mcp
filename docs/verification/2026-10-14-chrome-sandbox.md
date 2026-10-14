# Keep Chrome's sandbox enabled

After successful manual login reported by the user, the automated stage opened
and displayed a Cloudflare human-verification challenge. The screenshot also
showed Chrome's `--no-sandbox` warning. Neither establishes loss of the account
session or successful authentication in the automated stage.

Installed Playwright `lib/coreBundle.js:43075` adds `--no-sandbox` unless
`chromiumSandbox === true`. The visible browser driver now explicitly sets that
option. It still preserves the system credential store, does not suppress
automation identification, and does not solve or bypass Cloudflare challenges.

Stopped only the exact owned controller and relaunched with:
`bun run scripts/start-visible-browser.ts --launch-id d946b5e9-231e-4b13-83ce-5170cf353658`.
The same owned profile was reused; no credentials or cookies were copied.
Actual Chrome PID 49415 had no `--no-sandbox`, `--password-store=basic` or
`--use-mock-keychain` arguments. This verifies the process launch configuration,
not a full audit of Chromium's internal sandbox.

Raw private evidence:
`/home/danny/.codex-web-http/visible/d946b5e9-231e-4b13-83ce-5170cf353658/sandbox-enabled-evidence.json`.
SHA-256 `f015933d907b537e61515467da9274278eabcf002bc667d768dd4720b2f2c355`.

User handoff: complete the human-verification checkbox in this corrected
window. Account-session retention, an authenticated automated observation and
the complete conversation remain NOT_DEMONSTRATED pending that step.

Subsequent user screenshots show no `--no-sandbox` warning and Cloudflare
`Verificando…`; they do not show the authenticated ChatGPT composer. Preserve
that distinction instead of declaring session reuse successful or lost.

Final `bun test`: exit 0, 538 pass, 1 skip, 0 fail; 539 tests across 79 files.
Raw `/home/danny/.codex-web-http/canaries/visible-chrome-sandbox-suite-20261014.txt`,
SHA-256 `54b969bd200b3c7fa42da3a0f9224b3cf52e6b147cffdb3974d00f86ecfb0c54`.
