# Visible Chrome E2E Round Trip — PASS — 14 October 2026

## Executive Summary

The visible end-to-end (E2E) verification of the **ISyMCP** pipeline has been **DEMONSTRATED (PASS)** on official ChatGPT Web (`https://chatgpt.com/c/6acfefe1-3664-83e8-b95a-8b5e936dde0a`).

The full round trip succeeded across all 5 logical stages:
1. **Host Launch & Unblocked Session:** Chrome opened with isolated profile `d946b5e9-231e-4b13-83ce-5170cf353658` on loopback CDP with `navigator.webdriver = false` (via `--disable-blink-features=AutomationControlled`). Cloudflare Turnstile did not block.
2. **Connector Attachment:** `@Codex ISyMCP` was selected with connector identity `app://asdk_app_6ace90ad54848191912160b8880294c7`.
3. **Turn Start & Tool Inventory:** `codex_turn_start` validated the minted session token `yKgSZ10vP6TGIB28_DHkyWUwpJUoRVU-jxx9bz0JrbU` (fingerprint `1613b49b0a7d`). `bootstrap.content` was served. `codex_tool_inventory` returned 8 executable tools and capabilities.
4. **Command Execution in Sandbox:** `codex_exec` executed `printf ISYMCP_E2E_VISIBLE_OK\n` inside the `bwrap-read-only` sandbox for `/tmp/isymcp-e2e-canary-20261014`.
   - **Exit code:** `0`
   - **Duration:** `18 ms`
   - **stdout:** `ISYMCP_E2E_VISIBLE_OK\n`
   - **stderr:** empty (len: 0)
5. **Turn Completion:** `codex_turn_complete` closed the turn cleanly (`completed: true`, `live_execs_killed: 0`). ChatGPT received the tool result, displayed the execution confirmation, and concluded the turn.

## Verifiable Receipts and Hashes

- **Conversation URL:** `https://chatgpt.com/c/6acfefe1-3664-83e8-b95a-8b5e936dde0a`
- **Rendered Message ID:** `9e48d1e6-fa91-459f-a665-276b0673b354`
- **Session Fingerprint:** `1613b49b0a7d` (revoked post-test)
- **Local MCP Trace:** `~/.codex-web-http/mcp-trace.log`
- **MCP Trace Slice SHA-256:** `f9a099de3b608144d8f7a89aa0ea069c245763146723df1d3ef95c3b869bf0af`

```json
2026-10-14T21:11:18.488Z call {"tool":"codex_turn_start","token_fp":"1613b49b0a7d","session":"session-2026-10-14T21:04:56[1613b49b0a7d]","turn_id":null}
2026-10-14T21:11:22.989Z call {"tool":"codex_tool_inventory","token_fp":"1613b49b0a7d","session":"session-2026-10-14T21:04:56[1613b49b0a7d]","turn_id":null}
2026-10-14T21:11:22.996Z tool.result {"tool":"codex_tool_inventory","token_fp":"1613b49b0a7d","turn_id":null,"ok":true}
2026-10-14T21:11:26.262Z call {"tool":"codex_exec","token_fp":"1613b49b0a7d","session":"session-2026-10-14T21:04:56[1613b49b0a7d]","turn_id":null}
2026-10-14T21:11:26.269Z exec.spawn {"writable":false,"workdir":"/tmp/isymcp-e2e-canary-20261014"}
2026-10-14T21:11:26.284Z exec.stdout {"len":22}
2026-10-14T21:11:26.285Z exec.stderr {"len":0}
2026-10-14T21:11:26.286Z exec.exited {"exitCode":0,"timedOut":false}
2026-10-14T21:11:26.286Z tool.result {"tool":"codex_exec","token_fp":"1613b49b0a7d","turn_id":null,"ok":true,"command":"printf ISYMCP_E2E_VISIBLE_OK\n","exit_code":0,"duration_ms":18}
2026-10-14T21:11:33.431Z call {"tool":"codex_turn_complete","token_fp":"1613b49b0a7d","session":"session-2026-10-14T21:04:56[1613b49b0a7d]","turn_id":null}
```

## Claim Status

| Claim | Status |
|---|---|
| Owned normal Chrome process and loopback CDP selection | DEMONSTRATED (PASS) |
| Model and effort inspection on live ChatGPT web | DEMONSTRATED: GPT-6, medium (PASS) |
| Stale socket recovery and clean close on page exit | DEMONSTRATED (PASS) |
| Cloudflare Turnstile clearance | DEMONSTRATED (PASS) |
| Connector invocation from this host | DEMONSTRATED (PASS) |
| Browser-to-native MCP tool round trip from this host | DEMONSTRATED (PASS) |
| Real command execution in bwrap sandbox | DEMONSTRATED (PASS) |
| Full visible conversation E2E | **DEMONSTRATED (PASS)** |
