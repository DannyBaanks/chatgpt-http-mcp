# ISyMCP conversational Web — handoff

Stopped at the user's explicit request to conserve the subscription budget.
The next agent should continue from this checkout, without restarting the
investigation or changing the global Codex provider.

## Checkout and approved scope

- Working repository: `/home/danny/Development/ISyCo Git/chatgpt-http-mcp-impl`.
- Branch: `codex/guided-video-cli`; parent before this handoff: `e0e0a33`.
- Plan: `docs/superpowers/plans/2026-10-09-conversational-native-tools.md`.
- Approved: a new Codex CLI/App task creates a ChatGPT Web conversation and
  stays bound to its canonical URL across tools, later messages and resume.
- Codex executes the tools and retains sandbox, approvals and process ownership.
  The Web adapter only translates requests/results.
- CLI and desktop App require independent real acceptance tests. A protocol
  fixture, daemon-created thread or desktop launcher is not App verification.
- The root workspace `/home/danny/Development/ISyCo` is a different monorepo
  with no remote. Do not push it. Preserve the primary sibling checkout and
  its existing changes.

## Preserved isolation

The previous incident was caused by a global `openai_base_url` routing native
Codex models through a dead local bridge. The repair is committed in the
parent: normal startup/restart does not rewrite the user's provider.

Web launch uses named provider `isymcp_web` and a private model catalog only
for that process. Native models bypass the bridge. An explicitly selected
`-p`/`--profile` also bypasses it unless an explicit Web model opts in.
Do not fix availability by reinstalling a global loopback base URL.

At handoff, `/home/danny/.codex/config.toml` still selects `gpt-6-luna` and
contains no global `openai_base_url`. Existing native chats must remain usable.
`isymcp-media` is a separate stdio MCP; its presence is not thread ownership.
Do not close the desktop, evict another app-server, or release the user's
conversation locks to make a canary pass.

## Changes in this handoff commit

1. Added opt-in `chatgpt-web/gpt-6` / High support alongside GPT-5.6 Sol.
   `CODEX_WEB_HTTP_CAPS=gpt6` advertises it; the conservative default remains
   Sol. There is no silent 5.6-to-6 or 6-to-6.1 mapping. Context limits are
   explicitly an adapter budget, not a verified backend context capacity.
2. Task preflight selects the exact requested model and verifies High 3/3;
   response metadata uses that model instead of hardcoding GPT-5.6 Sol.
3. New-home navigation avoids a redundant `goto` that discarded a hydrated
   composer. Other conversation URLs still require navigation.
4. Composer control lookup waits for readiness and scopes to its form.
   Selection handles the new simple/advanced menu: model rows remain attached
   but are inert/aria-hidden in the simple power view. Expand before clicking.
5. Launcher parses whitespace around TOML assignments and respects explicit
   profiles. `--model` precedence and the prompt delimiter remain covered.
6. Isolated Web profile disables the unsupported native `web_search` built-in.
   Native/global search remains unchanged. Unknown built-ins still fail before
   Web submission; do not silently pretend to execute them.
7. Text transport excludes known inline-image tools, including MCP wrappers
   such as `_codex_view_image`, `_audio_analyze`, `_video_frame` and
   `_video_contact_sheet`. The separate native media MCP is not removed.
   General image/audio tool results remain unsupported by this Web transport.

## Exact current blocker — fix this next

`src/chatgpt-settings.ts:selectComposerSettings` passes local Chromium DOM
regressions, but the last real page probe failed before sending any message:

`web_effort_control_unavailable: expected one reasoning control`

The real menu's initial power row exists but has an empty child and zero
visible area while its slider component is still loading. The current helper
counts visible power controls immediately after opening the menu. It must wait
for the owned slider/control to become usable before counting/pressing it.
Do not merely extend an unrelated model-radio timeout or force-click inert
rows. Add a delayed-slider DOM regression, observe RED, then implement GREEN.

Observed HTML at failure:

```html
<div data-model-picker-view="simple">
  <!-- accessible model-view toggle -->
  <div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight"
       data-reasoning-slider="true" aria-label="Potencia">
    <span></span> <!-- slider had not mounted -->
  </div>
  <!-- attached model choices in an aria-hidden, inert advanced view -->
</div>
```

The checked model was GPT-6 and the existing effort was Medium 2/3. No live
High selection has yet succeeded in this turn. The user's screenshot about
release dates is not independently verified; do not state those dates as fact.

Useful reference checkout:
`/home/danny/Development/ISyCo Git/codex-chatgpt-web` at `bc94c6c`.
Inspect `src/adapters/chatgpt-web/model-selection.ts` and
`src/chatgpt-session.ts`; borrow the observed control contract, not its model
alias assumptions. Its Latest/effort mapping is not our model identity proof.

## Verification and private evidence

Fresh handoff check: **87 pass, 0 fail across 9 files**, including the local
Chromium composer fixture, native loop, exact model selection, launcher and
private installation. This is a targeted result, not a full-suite or live Web
success. `git diff --check` also passed.

Raw log:
`/home/danny/.codex-web-http/evidence/handoff-check/020f609fe9e4485fb8859cd7833ee9d9/targeted.txt`

SHA-256: `0861e51248191f9e3c1da8305a947eb385eddfef23681b072d9a542fed062e35`.

Latest live failure, including private DOM and screenshot:
`/home/danny/.codex-web-http/evidence/composer-live/30d84398-936a-4562-87ce-baf06c53de69/raw.json`

SHA-256: `e6fdc4ade60d1d442487c6d5c1ea5622992c4da2d42364a037f22c4a0ad6c33a`.

Earlier live probes remain preserved, including the inert-model-row timeout.
No cookie snapshot was overwritten and no message was submitted by these
selection probes. Do not delete failed probes or reinterpret them as passes.

Launcher profile RED/GREEN evidence:
`/home/danny/.codex-web-http/evidence/launcher-profile/e75a13c2-7a9f-4bdc-850d-14478e61b479/green.txt`

SHA-256: `1dbc05a57b4b68f85a1acf94e5f85b701466979e1c1fb3eec2eceeffffdef3a1`.
A real CLI against a private HTTP fixture also confirmed `-p native` selected
`gpt-6-luna`, exit 0; this was not a real OpenAI response.

Other private review receipts:

- Guided CLI contract:
  `/home/danny/.codex-web-http/evidence/guided-cli-contract/3c47eba5ff0a4819bf4bf8cd85ed11f8/receipt.json`,
  SHA-256 `e3bd89d5d5086dd4828fa6ae1fd9d7d9f6664f0df67b5721bc33ca41eca35e23`.
- Desktop provider contract:
  `/home/danny/.codex-web-http/evidence/app-provider-contract/9ddb4b064ffe43e6885cbce6d012c45b/contract-receipt.json`,
  SHA-256 `9525a99a05df0fbc33faa67d44c488374b55c6a12a842b3f4240f4b1caa829ae`.

Private raw requests may contain user context. Never paste them wholesale,
commit browser storage/authentication, or print bridge lease tokens.

## Continue by milestone

### Finish Task 2 gate

After fixing readiness, run a read-only live selection probe and verify exact
model plus High 3/3. Existing helper scripts are in `/tmp`:

- `/tmp/isymcp-power-live-probe.ts`: no-send selector probe and DOM evidence.
- `/tmp/isymcp-web-cli-real-canary.ts`: prepared but **not run**. It starts an
  owned temporary bridge, private catalog and read-only Codex exec. Web must
  request a native `exec_command`; Codex prints a unique nonce; Web receives
  the real result and returns that exact nonce. It captures real requests,
  CLI JSONL and hashes. Check the script against current code before running.

The script uses `capabilities` (not the previously mistaken `accountCaps`),
normal existing authentication, and ignores user rules/config for its isolated
canary. Close only its owned browser/server/process. Do not retry a message
whose submission became ambiguous; retain the ledger and inspect first.

### Task 3 — guided conversation entry is NOT IMPLEMENTED

Minimum proposed entry: `isymcp conversation new|list|resume <id>` and TUI
"Nueva conversación Codex", choosing CLI/App and workspace.

Reuse `buildCodexArgs`, `installWebModels`, `isBridgeAlive` and the interactive
`codexCommand` in `src/isymcp.ts`. Launch CLI with a per-process provider and
`--no-daemon` to avoid the shared server. Preserve normal interactive Codex
approvals instead of bootstrapping with an unattended exec.

Create a private launch-intent UUID and pass `x-isymcp-launch-id` in this
provider's `http_headers`. On a verified committed response, save an idempotent
receipt containing launch ID, client, cwd, model/effort, real Codex thread ID,
canonical Web URL, task key and state. Rebuild it from a confirmed replay.
The existing task ledger only keeps URL/history; `listCodexTasks` exposes a
truncated hash and cannot currently construct an exact Codex resume.

Resume must use the saved exact thread ID, model, cwd and provider; never
guess by time, use `--last`, or create another Web conversation. Gate two
independent chats, native command/result, a later user turn and a fresh-process
resume retaining the same canonical URL.

Desktop App currently has no verified public per-thread custom-provider entry.
The installed app-server schema accepts configuration, but the desktop MCP
`create_thread` does not expose arbitrary provider/config and validates official
models. A standalone app-server/daemon is not the desktop. `--client app`
must fail clearly until a real supported entry is demonstrated; do not restore
the global hijack as a workaround.

### Task 4 — not complete

Run a fresh full suite after all changes settle, real CLI canary and separate
available App gate. Update GUIA/README and the milestone ledger with verified
behavior and limitations. Fresh review, scoped commit, bridge result/release.
Do not report "100%" before the required executable gates pass.

## Coordination for the next agent

Follow root RTK/AGENTS and perform your own bridge hello/peek/status before
claiming the subsystem. Previous agent was
`codex_isymcp_recover_81f462e1ab`, topic
`isymcp/conversational-native-tools`; the handoff commit precedes release.
No new task or automation was created and no user conversation was archived.

## Continuation after the handoff commit

The next session continued from `d511cd0` without restoring a global
`openai_base_url`. `~/.codex/config.toml` still selects `gpt-6-luna`; its
SHA-256 stayed `dc56c54a75e3aeac23ab5ef1857e0d2852c7725af2926780946c277dea469f23`.

### Slider readiness — fixed and checked live

`selectComposerSettings` waits until the owned power row is visible and its
slider exposes one 3-step scale, then presses ArrowRight. It does not click
inert model rows. The delayed-slider DOM regression failed first with
`web_effort_control_unavailable: expected one reasoning control`, then passed.

Targeted suite after the fix: **88 pass, 0 fail across the same 9 files**.
Read-only live probe, no message submitted, observed GPT-6 / High / 3 / 3:

`/home/danny/.codex-web-http/evidence/composer-live/81b981e2-40a3-4e25-aee8-fe5dd9d517fa/raw.json`

SHA-256: `cc70b0071894c276d6f46176c2e9a04959cadb58815b0fab5107216c1e9e613f`.

### Task 2 CLI canary — NOT_DEMONSTRATED

`/tmp/isymcp-web-cli-real-canary.ts` was run once against current code. Codex
exited 1 in about 15 s, before the temporary bridge received any request:

`You’ve hit your usage limit ... try again at Oct 10th, 2026 3:59 AM.`

Evidence:
`/home/danny/.codex-web-http/evidence/web-cli-live/59ee7ebc-1849-4a1d-a2b5-be1e6de3757f/receipt.json`

SHA-256: `c6176d564f4a275d6b5263f03978976b65c13f4b362919c6d3b6b8c8aa12866b`.

This is an account quota stop, not a Web transport pass. It was not retried.

### Task 3 — CLI entry added, live resume still open

`isymcp conversation new|list|resume` and the TUI item "Nueva conversación
Codex…" are implemented. The launch is interactive, uses `--no-daemon`, and
sends `x-isymcp-launch-id` through the process environment. A committed turn
writes an idempotent receipt; replay rebuilds that receipt. Resume uses the
saved thread id, model and workspace. `--client app` fails closed. Two real
chats, a native command and a fresh-process resume were not run: the same
Codex quota blocked the client. Full suite, App gate and a "100%" claim remain
open.
