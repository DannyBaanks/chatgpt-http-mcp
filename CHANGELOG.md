# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed

- Wrap every `src/` line longer than 160 columns without behavior changes (61 files; literals and regexes verified equivalent).
- Give process-spawning integration tests explicit time budgets (30-90 s) instead of relying on Bun's 5 s default; three consecutive full suites pass under controlled CPU load.
- Bump `@modelcontextprotocol/sdk` from 1.30.0 to 1.32.2 and refresh transitive dependencies within range.

### Security

- `bun audit` now reports 0 vulnerabilities (was 14: 6 high, 6 moderate, 2 low), via body-parser 2.4.0, fast-uri 3.1.9, ip-address 10.7.4, qs 6.16.1 and zod 4.6.6.
- Add `SECURITY.md` with private reporting instructions, supported versions and scope.

### Documentation

- Refresh the README test badge and suite count (705 pass / 3 skip / 0 fail across 107 files) and add the 2026-10-31 verification record.

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
