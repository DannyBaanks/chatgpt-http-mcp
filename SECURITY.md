# Security Policy

ISyMCP is experimental local software that runs a loopback HTTP bridge, MCP
servers, a sandboxed command runner and browser automation. It is not a hosted
service and it is not affiliated with OpenAI. The security model and known
limitations are documented in the [README](README.md#security-model) and the
[compliance assessment](docs/compliance/FINAL_VERDICT.md).

## Supported versions

| Version | Supported |
| --- | --- |
| `1.0.1` | Yes |
| `1.0.0` and older tags, release candidates and forks | No |

Only the latest stable release and the `main` branch receive security fixes.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

<https://github.com/DannyBaanks/chatgpt-http-mcp/security/advisories/new>

Do **not** open a public issue for a vulnerability, and never include live
session tokens, cookies, `CODEX_WEB_HTTP_TOKEN`, account identifiers or private
workspace paths in a report. Redact them; a placeholder is enough.

A useful report includes:

- affected version or commit;
- operating system and how the bridge was started;
- reproduction steps or a proof of concept;
- observed impact and the boundary that was crossed;
- whether the bridge was exposed beyond loopback;
- any credentials that may have leaked (redacted).

This is a volunteer, single-maintainer project without a formal SLA. Reports
are reviewed as capacity allows; please allow time before public disclosure and
coordinate the disclosure date with the maintainer.

## Scope

In scope:

- authentication and authorization for the bridge, panel and MCP sessions,
  including loopback token enforcement, `Host`/`Origin` checks and session
  revocation;
- command injection, path traversal, sandbox escape (`bubblewrap`, Docker,
  native Codex sandbox) and writes outside the selected workspace;
- leakage of tokens, cookies or conversation data through logs, receipts, the
  panel or exported artifacts;
- MCP servers (`chatgpt.ts`, `media.ts`) and the local media pipeline;
- denial of service that crosses the documented local boundary.

Out of scope:

- OpenAI or chatgpt.com service behavior, account restrictions, rate limits or
  bans resulting from automation; those are policy risks, not vulnerabilities
  (see the [compliance assessment](docs/compliance/FINAL_VERDICT.md));
- website DOM changes, Cloudflare challenges or browser login flow breakage;
- attacks that require pre-existing root or full control of the same OS account,
  unless they cross a documented isolation boundary;
- third-party dependency advisories: report them upstream. We track them with
  `bun audit` and update dependencies;
- social engineering and physical access.

Testing must be limited to systems and accounts you own or are explicitly
authorized to test. Do not test against OpenAI services or third-party accounts.

## Baseline

On 2026-10-31, `bun audit` reports **0 vulnerabilities in 116 packages**, down
from 14 (6 high, 6 moderate, 2 low) after upgrading
`@modelcontextprotocol/sdk` to 1.32.2 and refreshing transitive dependencies
within range. The full test suite passes 705 tests with 3 opt-in skips and 0
failures across 107 files. Details and commands:
[verification record](docs/verification/2026-10-31-suite-stability-and-dependency-audit.md).
