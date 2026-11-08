# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-11-08

Release of the local ISyMCP Control Center and agent coordination surface.

### Added

- Local Control Center with CLI command deck, service monitoring and task views.
- Dedicated read-only MCP tools for overview, glossary, tasks and protocol.
- Private ChatGPT integration resources and initial Apps SDK UI entrypoints (experimental; connected-host E2E not implied).
- Task-monitor, agent/console registry and workflow observability improvements.

### Security & Reliability

- Operator-grant checks for privileged Control Center operations, with scoped one-use HMAC authorization and workspace binding.
- Expanded negative/adversarial tests for command authority, secrets handling and MCP routing.
- Improved Windows session-registry contention handling and concurrent-write stress test (intermittent failures still require monitoring).

### Documentation

- Product-oriented README and linked in-depth technical documentation.
- Browser automation remains experimental and is not an official OpenAI API or platform endorsement.

## [1.0.2] - 2026-11-07

Security boundary hardening release following an architectural review
using the Elephant-Goldfish Model (EGM) and peer adversarial review.

### Security

- **Panel Credential Isolation & Loopback Hardening**:
  - Eliminated `window.__ISYMCP_TOKEN__` completely from DOM HTML, templates, and frontend scripts (`src/panel.ts`, `src/panel-chat.ts`).
  - Added ephemeral single-use bootstrap ticket mechanism (`mintPanelTicket` / `redeemPanelTicket`) exchanged for an HMAC-SHA256 signed `isymcp_session` session cookie (`HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`).
  - Mutating panel endpoints (`POST /api/action`, `POST /api/harness/apply`, `POST /api/chats/*`, `POST /api/settings/*`) enforce `guardLocalRequest` with token or cookie authorization; unauthenticated requests fail closed with HTTP 401.
  - Non-loopback Host headers on panel routes are rejected immediately with HTTP 403 (DNS rebinding prevention).
- **Process Hierarchy Termination on Linux**:
  - Upgraded `stopProcessTree` and `killUnregisteredProc` to execute `pkill -TERM -P <pid>` while the parent process is alive, followed by process-group kill (`process.kill(-pid, "SIGTERM")`) and hard timeout escalations (`pkill -9 -P <pid>`). Detached background descendant jobs no longer persist as zombies.
- **Symlink Confinement Hardening**:
  - Switched `runApplyPatch` target path verification to `resolveWithinReal`, recursively resolving ancestor directory symlinks to block escapes outside workspace root.
- **Synchronous Session Validation & Multi-Turn Background Tasks**:
  - Indexed `LiveExec` background process records by root session fingerprint (`session.parent ?? session.fp`) to enable multi-turn prompts to manage background processes across turns.
  - Synchronously verified active session existence against `codex-sessions.json` on disk in `findLive` and `sweepLiveExecs`, terminating active processes immediately upon revocation or expiration.

### Changed

- Bumped package version to `1.0.2` and Windows sandbox image tag to `isymcp-sandbox:1.0.2`.
- Added 11 automated adversarial security tests in `tests/security-boundary.test.ts` (`SEC-TEST-01` to `SEC-TEST-11`).

## [1.0.1] - 2026-10-31

Patch release on top of 1.0.0. It contains a single diagnostics fix and the
matching version/tag updates; no behavior of the bridge, MCP tools or sandbox
changes.

### Fixed

- `isymcp doctor` no longer reports a stale media failure forever. The last-failure
  check now ignores an old failed import once a newer import has completed, so a
  recovered catalog reads `ok · sin fallos registrados`. Raw evidence is untouched:
  every `job.json` (success and failure) is preserved on disk.
- Historical failures that predate the stable error codes surfaced as `media_unknown`
  and could not be cleared by the documented "retry" remedy, because a successful
  retry writes a new job and leaves the old failed one as the latest failure.

### Changed

- Bump the version to `1.0.1` and the Windows sandbox image tag to `isymcp-sandbox:1.0.1`.
- Add a regression test covering both the recovered and the still-failing catalog states.

## [1.0.0] - 2026-10-31

First stable release. It consolidates the rc.2 snapshot plus the security,
stability, formatting and documentation work below.

### Changed

- Wrap every `src/` line longer than 160 columns without behavior changes (61 files; literals and regexes verified equivalent).
- Give process-spawning integration tests explicit time budgets (30-90 s) instead of relying on Bun's 5 s default; three consecutive full suites pass under controlled CPU load.
- Bump `@modelcontextprotocol/sdk` from 1.30.0 to 1.32.2 and refresh transitive dependencies within range.
- Rename the Windows sandbox image tag to `isymcp-sandbox:1.0.0`.

### Security

- Require the bridge's own token (created with mode 0600 on first start) on every loopback route, including `/v1/*`, `/isymcp/*`, health, metrics and the WebSocket; fail closed with 503 if the token cannot be prepared.
- Stop `chatgpt_ask` and the MCP route on a reported OpenAI block: record `provider.blocked`, return `provider_blocked` with `isError`, and never retry.
- Keep the native broker socket in a private 0700 directory (`$XDG_RUNTIME_DIR/isymcp/broker.sock` or `<bridge home>/run/broker.sock`) instead of a shared `/tmp` path.
- `bun audit` now reports 0 vulnerabilities (was 14: 6 high, 6 moderate, 2 low), via body-parser 2.4.0, fast-uri 3.1.9, ip-address 10.7.4, qs 6.16.1 and zod 4.6.6.
- Add `SECURITY.md` with private reporting instructions, supported versions and scope.

### Decision

- The account owner accepted the compliance verdict (`docs/compliance/FINAL_VERDICT.md`).
- The autonomous native-browser line is frozen for 1.0.0: entrypoints keep returning `503 native_browser_unavailable`, no remote retries are performed, and it remains blocked until a documented, authorized owner/browser adapter exists.

### Documentation

- Refresh the README test badge and suite count (705 pass / 3 skip / 0 fail across 107 files) and add the 2026-10-31 verification record.
- Add dated operator-guide sections and release notes for 1.0.0.

## [1.0.0-rc.2] - 2026-10-14

### Changed

- Align the release snapshot with the merged Codex profile and visible-browser integration changes that followed the rc.1 tag.
- Add linked release/tag navigation, source-download instructions and explicit release-candidate status to the README.
- Read the CLI help version from package metadata rather than a hard-coded string.
- Publish versioned source archives and SHA-256 checksums only after successful main-branch CI.
- Keep historical rc.1 tags intact; release notes distinguish recorded evidence from fresh verification.

## [1.0.0-rc.1] - 2026-10-14

### Highlights

- **Verified Two-Way E2E Round Trip (`[CURRENT] PASS`)**: Demonstrated and certified end-to-end execution between ChatGPT Web, local native broker, isolated `bubblewrap` sandbox, and return to ChatGPT Web. Verified with live canary nonces (`ISYMCP_TWOWAY_4afa0c89`), 18 ms execution duration, 0 child processes terminated, and live response receipts.
- **OpenAI Compliance & Account Safety Governance V1 (P0)**: Established a formal fail-closed governance framework across 9 audit deliverables (`docs/compliance/`). Distinguishes authorized human interaction in Chrome visible (`ALLOW`) from bot-driven UI typing/scraping (`DENY` per ToU §2(c)(iii)). Enforces immediate HALT upon server-side safety classifier triggers with zero prompt evasion or tool hopping.
- **Isolated & Decoupled Codex Environments**: Native support for Codex CLI and Codex Desktop App via isolated `isymcp_web` Responses provider, private profiles, and thread journals under `~/.codex-web-http/codex-profiles/isymcp-web` without mutating global `~/.codex/config.toml`.
- **Modernized Host Landing & Visual Dashboard**: Full dashboard at `http://127.0.0.1:8798` with dynamic visible Chrome session detection, local loopback CDP controller, isolated profile metadata, and live Compliance P0 telemetry.
- **Comprehensive Test Parity**: **545 tests passing / 1 skipped / 0 failed across 81 files** (`bun test`).

### Added

- `src/visible/browser-turn.ts`: Visible browser turn adapter with `findActiveVisibleSession` and `sendVisibleWebTurn`.
- `src/visible/browser-host.ts`: Modern HTML host landing page with dark mode, CDP port detection, and P0 safety notices.
- `src/panel.ts`: Visual status cards for Chrome Visible session, native broker, and OpenAI Compliance P0.
- `src/codex-conversation.ts`: Conversation launcher and persistence for CLI and Linux Desktop App.
- `src/isymcp.ts`: Added `isymcp version`, `--version`, `-v`, and updated help menus.
- `docs/compliance/`: Comprehensive 9-part OpenAI policy audit and threat model.
- `docs/verification/`: Verification records for visible Chrome E2E and two-way return loop.

### Fixed

- Socket timeout handling in `src/server.ts` (`idleTimeout: 0`) to prevent socket aborts during multi-step execution turns.
- Preserved Chrome sandbox flags (`--user-data-dir`, `--no-first-run`, `--disable-blink-features=AutomationControlled`).
- Cleaned up lingering stale git index locks and process management.

---

## [0.9.0] - 2026-10-10

### Added

- Scoped session broker and MCP tunnel connector (`@Codex ISyMCP`).
- Local media processing suite (RMS audio activity scan, contact sheets, YouTube importer).
- Multi-agent harness connectors for Claude Code, Cursor, OpenCode, and Copilot CLI.
- Bubblewrap sandbox isolation (`bwrap-read-only`) for local tool execution.
