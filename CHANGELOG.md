# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

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
