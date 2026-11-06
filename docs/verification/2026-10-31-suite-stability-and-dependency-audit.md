# Suite stability under load, source formatting and dependency audit — 2026-10-31

Status: **PASS** for the three items below.

Environment: Ubuntu 24.04 x64, Bun 1.4.2, TypeScript 7.0.2 (`tsc --noEmit`),
FFmpeg and Chromium available for the integration tests. Counts and advisories
are pinned to this date.

## Method

- Controlled load: six `yes` processes at `nice -n 5`; `uptime` load average
  recorded before and after each run.
- Full suite: `bun test`. Bun runs test files serially; the default per-test
  budget is 5000 ms and an explicit per-test timeout overrides it.
- Raw local logs were kept in `/tmp/fs05-*.log` but are not committed. SHA-256
  of the three final loaded logs:
  - `fs05-loaded-1.log`: `cd0602cccf45034254c7f18832b7786428b53e547e39ada7bccb32e85f4ef145`
  - `fs05-loaded-2.log`: `a3f85adeed347c76325b3e3634757401d0e60e0b27be5cf6c759128aed3220f5`
  - `fs05-loaded-3.log`: `e791e6b1096597cca6a06d86c7ec8bd090ee31752eb142678256b2d8f21a3ac6`

## FS-05 — suite stability under load

Pre-fix baseline under external CPU load: `bun test` reported **690 pass,
3 skip, 16 fail, 6 errors** across 708 tests in 107 files, 374.06 s, exit 1.
The failures concentrated in process-spawning integration tests that kept
Bun's 5000 ms default: Chromium launch and setup, FFmpeg fixture generation,
CLI launches and harness probes.

Fix: explicit budgets only where the test crosses a process boundary.

| Area | Budget |
| --- | --- |
| General integration tests (media, export, doctor, sessions, harness diagnostics) | 30 s |
| Native 64th/65th tool-loop calls and the guided CLI flow | 60 s |
| `e2e-all` unified smoke (each harness probe carries a 20 s budget) | 90 s |
| Chromium `beforeAll` for composer/panel E2E | 60 s |
| CLI end-to-end file and lifecycle tests, panel/composer `afterAll` | 30 s |
| Live MCP stdio session tests (`tests/mcp-session.test.ts`) | 30 s (the existing exec-timeout test keeps 20 s) |

The global default stays at 5 s for unit tests; no global timeout was raised.

Validation steps:

1. Targeted subset (74 tests, 10 files): 73 pass, 1 fail — `runDoctor` timed out
   at 5042.43 ms, exposing one remaining default budget. Its budget was raised
   to 30 s.
2. Quiet streak: two consecutive full runs green at 64.52 s and 63.84 s.
3. A loaded run still failed the tunnel/server lifecycle CLI test at
   5000.86 ms; explicit budgets were added to the remaining `cli-e2e` tests and
   to the panel/composer hooks.
4. Final streak under controlled load (load average 9.91 → 11.34): three
   consecutive full runs, **705 pass / 3 skip / 0 fail**, 708 tests in 107
   files, exit 0, in **91.73 s, 98.50 s and 91.12 s**.

The 3 skips are opt-in or platform-gated, not failures: Windows native MCP E2E
(`ISYMCP_WINDOWS_NATIVE_E2E=1`), installed Video Vision real frame, and the
native Windows profile launchability check.

The 1.0.0 release re-run exposed one more remaining default budget:
`MCP con session tokens (vivo) > token desconocido conserva el stub de compat`
timed out at 5172.42 ms under load. All six live MCP stdio tests in
`tests/mcp-session.test.ts` now declare 30 s budgets (the existing
exec-timeout test keeps 20 s). The release re-run after that change is recorded
below.

Release re-run (2026-10-31, normal machine load): **705 pass / 3 skip / 0 fail**,
708 tests in 107 files, 68.34 s, exit 0.

## FS-06 — zero source lines over 160 columns

All `src/` lines longer than 160 columns were split (61 files). The change is
formatting-only:

- string and number literals were folded and compared against the previous
  commit with an independent verifier;
- identifier and literal streams match except for two regex literals converted
  to `new RegExp(String.raw` chains in `src/tool-trace.ts` and
  `src/web-turn.ts`; `source` and `flags` were verified identical;
- `bun run typecheck` passed and the full suite stayed green;
- merged as commit `5be3a2b` (PR #40), with `test` and `windows-host` CI green.

## FS-09 — dependencies, documentation and SECURITY.md

Dependency changes:

- `@modelcontextprotocol/sdk` 1.30.0 → 1.32.2 (direct).
- `bun audit fix` within ranges: body-parser 2.3.0 → 2.4.0, fast-uri
  3.1.8 → 3.1.9, ip-address 10.7.3 → 10.7.4, qs 6.16.0 → 6.16.1, zod
  4.6.5 → 4.6.6.

Verification after the bump:

```text
bun audit          -> No vulnerabilities found (checked 116 packages)
bun run typecheck  -> exit 0
bun test           -> 705 pass, 3 skip, 0 fail, 708 tests, 107 files, 66.46 s
```

Before the bump, `bun audit` reported 14 vulnerabilities: 6 high, 6 moderate,
2 low, including the direct MCP SDK and zod.

Documentation updated in the same change:

- README test badge and full-suite count now reflect 705 pass / 3 skip across
  107 files;
- `SECURITY.md` added with private reporting instructions, supported versions
  and scope;
- CHANGELOG has an Unreleased section for the formatting, test-budget and
  dependency changes;
- the Spanish operator guide (GUIA.md) has a dated 2026-10-31 section.

## Limitations

- The load was simulated with CPU contention on one Linux machine; it does not
  guarantee every CI runner or OS behaves identically.
- Test and advisory counts drift as tests and the advisory database change;
  this record pins the 2026-10-31 state.
- No live browser, native-owner or account-based E2E claim is made here. Those
  capabilities remain covered by their own records.
