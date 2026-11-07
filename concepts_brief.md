# ISyMCP Security Boundary Hardening

* **Author:** DannyBaanks
* **Date:** 2026-11-07
* **Status:** Draft / Post-Adversarial Consensus
* **Version:** 1.0.1 Hardening RFC Preparation

## Overview

This brief defines a bounded security hardening plan for ISyMCP v1.0.1. ISyMCP bridges local coding agent workflows with ChatGPT through a local HTTP/SSE daemon (`src/server.ts`), a web management panel (`src/panel.ts`), a Cloudflare tunnel client, and an MCP stdio server (`src/mcp/main.ts`) executing commands in Bubblewrap (Linux) or Docker / Codex CLI (Windows).

An architectural audit conducted across seven independent Elephant-Goldfish Model (EGM) review lenses and stress-tested through mandatory adversarial critique evaluated whether expired, revoked, malformed, or cross-session requests can reach execution capabilities. The evaluation confirmed that core workspace command execution (`codex_exec`, `codex_apply_patch`) fails closed when presented with invalid tokens. However, the audit revealed three major boundary inconsistencies:
1. An unauthenticated loopback administrative plane in the visual panel daemon (`src/panel.ts`).
2. Unauthenticated media downloader and image generation tools exposed directly over public tunnel transports (`src/media/register.ts`, `src/comfyui/register.ts`).
3. Decoupled lifecycle management between on-disk session revocation and in-memory background process termination (`src/mcp/exec-registry.ts`).

This proposal hardens these boundaries with minimal, non-destructive, reversible changes while preserving compatibility with existing Codex, Claude Code, and terminal workflows.

---

## Current Architecture & Trust-Boundary Map

ISyMCP exposes four distinct transport surfaces with divergent authentication models:

```mermaid
flowchart TD
    subgraph External ["External Untrusted Boundary"]
        Tunnel["Cloudflare Tunnel / Public Model Prompts"]
        LocalProcs["Unprivileged Host Processes / Local Origin"]
    end

    subgraph Transports ["Transport & Gateway Layer"]
        HTTPBridge["HTTP/SSE Bridge Server (:8791)"]
        WSBridge["WebSocket Route (/v1/responses)"]
        PanelServer["Panel Web Console (:8798)"]
        MCPStdio["MCP Stdio Protocol (tunnel-client)"]
    end

    subgraph AuthLayer ["Authentication & Guard Layer"]
        LocalGuard["local-guard.ts (Host/Origin + bridgeToken)"]
        PanelGuard["panel.ts (Host/Origin ONLY - requireToken: false)"]
        SessionReg["codex-sessions.json (Session & Turn Tokens)"]
    end

    subgraph ExecutionLayer ["Execution & Sandbox Layer"]
        CodexExec["codex_exec / codex_apply_patch (bwrap / Docker)"]
        MediaTools["media_import / yt-dlp (Host Process, No Sandbox)"]
        ComfyTools["comfyui_generate (Local GPU Daemon)"]
        BgExecs["exec-registry.ts (LiveExec Background Map)"]
        PanelActions["runPanelAction (Host Subprocess Spawn)"]
    end

    Tunnel -->|MCP JSON-RPC| MCPStdio
    LocalProcs -->|HTTP POST| PanelServer
    LocalProcs -->|HTTP POST| HTTPBridge

    HTTPBridge --> LocalGuard
    WSBridge --> LocalGuard
    PanelServer --> PanelGuard

    MCPStdio -->|Codex Tools + turn_token| SessionReg
    SessionReg -->|Valid Session| CodexExec
    SessionReg -->|background: true| BgExecs

    MCPStdio -->|Media / Comfy Tools (NO TOKEN)| MediaTools
    MCPStdio -->|Media / Comfy Tools (NO TOKEN)| ComfyTools

    PanelServer -->|POST /api/action| PanelActions
    PanelServer -->|Proxy turn + bridgeAuthHeaders| HTTPBridge
```

### Transport Invariant Comparison

| Transport Surface | Entry Point | Host / Origin Guard | Token Requirement | Session / Workspace Confining | Execution Capabilities Reachable |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **HTTP Bridge Server** | [`server.ts:70-175`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/server.ts#L70-L175) | Loopback / Allowlist | Enforced (`x-isymcp-token`) | N/A (Chat turns & model routing) | Web turns, headless browser sync, native model passthrough |
| **WebSocket Upgrade** | [`server.ts:189-242`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/server.ts#L189-L242) | Checked on HTTP upgrade | Enforced on upgrade; not checked per frame | N/A (Streaming turns) | Native WebSocket proxy, Web turn synthesis |
| **Panel HTTP Server** | [`panel.ts:659-695`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/panel.ts#L659-L695) | Loopback only | **Omitted** (`requireToken: false`) | N/A (Global admin surface) | Process spawn (`runPanelAction`), harness shell execution, chat turn relay with bridge token |
| **MCP Stdio Server** | [`mcp/main.ts:590-754`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/mcp/main.ts#L590-L754) | Inherited stdio / tunnel | **Asymmetric**: Enforced for Codex tools; **omitted for Media/Comfy** | Confined for Codex tools; **unconfined for Media/Comfy** | `codex_exec`, `codex_apply_patch`, `media_import`, `comfyui_generate` |

---

## Evidence Classification Matrix

The seven Goldfish review lenses classified findings based strictly on inspected code and test fixtures:

| Finding ID | Classification | Subsystem & References | Summary of Verified Technical Finding |
| :--- | :---: | :--- | :--- |
| **SEC-01** | **DEMONSTRATED** | [`src/panel.ts#L666`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/panel.ts#L666), [`src/panel.ts#L686-L689`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/panel.ts#L686-L689), [`src/panel.ts#L788-L794`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/panel.ts#L788-L794), [`src/panel.ts#L854-L857`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/panel.ts#L854-L857) | **Panel Confused Deputy & Missing Token Gate**: `startPanel` omits `requireToken: true`. Any local unauthenticated process on loopback can spawn actions (`/api/action`), rewrite agent harness configs (`/api/harness/apply`), and proxy chat turns to port 8791 using the panel's internal `bridgeAuthHeaders()`. |
| **SEC-02** | **DEMONSTRATED** | [`src/mcp/main.ts#L748-L751`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/mcp/main.ts#L748-L751), [`src/media/register.ts#L8-L12`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/media/register.ts#L8-L12), [`src/media/register.ts#L38-L44`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/media/register.ts#L38-L44), [`src/comfyui/register.ts#L47-L53`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/comfyui/register.ts#L47-L53) | **Unauthenticated Capabilities on MCP Transport**: While Codex tools mandate `turn_token`, `registerMediaTools` and `registerComfyTools` are attached to the tunnel MCP server without token validation. External prompt callers can download arbitrary videos up to 500 MiB via `yt-dlp` or dispatch local GPU generation jobs. |
| **SEC-03** | **DEMONSTRATED** | [`src/codex-sessions.ts#L287-L308`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/codex-sessions.ts#L287-L308), [`src/mcp/exec-registry.ts#L177-L199`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/mcp/exec-registry.ts#L177-L199), [`src/mcp/main.ts#L650-L655`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/mcp/main.ts#L650-L655) | **Orphaned Background Process Execution on Revocation**: Background processes spawned via `codex_exec` (`background: true`) are kept in memory in `exec-registry.ts`. Revoking a session (`isymcp session revoke`) deletes records in `codex-sessions.json` on disk, but never signals the running MCP process. Orphaned processes survive until the 15-minute inactivity timeout. |
| **SEC-04** | **DEMONSTRATED** | [`src/codex-sessions.ts#L255-L267`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/codex-sessions.ts#L255-L267), [`src/mcp/main.ts#L236-L237, L434-L436`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/mcp/main.ts#L434-L436) | **Cross-Turn Background Process Inaccessibility**: Turn 1 records `sessionFp: turn1.fp`. Turn 2 mints `turn2.fp`. If the model attempts `codex_write_stdin` with the Turn 1 `exec_id`, ownership comparison `rec.sessionFp !== session.fp` fails. Multi-turn workflows cannot manage background processes across turn boundaries. |
| **SEC-05** | **DEMONSTRATED** | [`src/isymcp.ts#L231, L248-L251, L280-L286`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/isymcp.ts#L231-L286), [`src/server.ts#L75`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/server.ts#L75) | **CLI Self-Denial on Protected Bridge Routes**: `server.ts` requires `x-isymcp-token` by default. In `isymcp.ts`, `askChatGPT` and `bridgeJson` issue fetch requests with bare headers omitting `TOKEN_HEADER`, causing immediate HTTP 401 Unauthorized errors on default server boots. |
| **SEC-06** | **DEMONSTRATED** | [`src/mcp/active-native.ts#L25-L33, L60-L63`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/mcp/active-native.ts#L25-L33) | **Windows Named Pipe Synthetic Inode Tautology**: On Windows, `socketIdentity` computes `socketInode` by hashing the lowercase pipe name string. Comparing `identity.socketInode !== owner.socketInode` is a tautology that always evaluates to true, failing to detect pipe recreation or impersonation. |
| **SEC-07** | **INFERRED** | [`src/mcp/main.ts#L319-L323`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/mcp/main.ts#L319-L323), [`src/codex-sessions.ts#L338-L344`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/codex-sessions.ts#L338-L344) | **Lexical Path Check Symlink Risk in Patches**: `runApplyPatch` uses `resolveWithin` (lexical checks) rather than `resolveWithinReal` (realpath checks). If a workspace contains a pre-existing symlink pointing to external host paths, patches could target files outside the workspace when sandboxing is disabled (`CODEX_WEB_HTTP_SANDBOX=off`). |
| **SEC-08** | **REFUTED** | [`src/codex-sessions.ts#L316-L335`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/codex-sessions.ts#L316-L335), [`src/mcp/main.ts#L619-L635`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/mcp/main.ts#L619-L635) | **Direct Execution Bypass via Expired or Revoked Tokens**: `findSessionByToken` fails closed, returning `null` for expired standard sessions and missing records. Handlers for `codex_exec` and `codex_apply_patch` fall back to inert stub receipts without invoking system execution. |
| **SEC-09** | **REFUTED** | [`src/mcp/active-native.ts#L22-L33, L206`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/mcp/active-native.ts#L22-L33) | **Native Codex Owner Protocol-5 Expiration Bypass**: Retaining tombstones in `findSessionByToken` allows returning explicit native error messages. `routeNativeTool` verifies `isExpired(session)` and throws `native_session_expired` before initiating socket RPC. |
| **SEC-10** | **REFUTED** | [`src/tunnel-routing.ts#L15-L24`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp-impl/src/tunnel-routing.ts#L15-L24) | **Tunnel Alias Hijacking & Split-Brain Collision**: `assertExclusiveTunnel` verifies that the configured alias uniquely owns its remote `tunnel_id` in `tunnel-client` inventory before connecting or stopping runtimes, halting fail-closed if shared. |

---

## Adversarial Critique & Resolved Contradictions (TRIZ)

Three architectural trade-offs were subjected to rigorous adversarial stress-testing by fresh-context reviewers (`egm-design`, `egm-zoom-out`, `egm-implementation-readiness`). The findings resulted in decisive improvements over initial hypotheses:

### Contradiction 1 (Decision A): Zero-Friction Browser UX vs. Confused Deputy Protection
* **Conflict**: Enforcing `requireToken: true` on `src/panel.ts` breaks browser navigation (`GET /` and `GET /fragment`) because browsers cannot attach custom HTTP headers without prompt friction. However, omitting `requireToken` allows unprivileged local processes to execute host actions and proxy turns.
* **Flaw of Initial Direction (Bootstrap Ticket -> Cookie Handshake)**:
  * Ephemeral tickets in URL query strings leak via process tables (`/proc/<pid>/cmdline` on Linux via `xdg-open`, and `Win32_Process` on Windows via `explorer.exe`).
  * Consuming a single-use ticket strands users on browser refresh (`F5`), tab reopening, or server restarts with HTTP 401 errors.
  * Deterministic testing of cookie jars in `bun:test` is fragile and requires extensive mock scaffolding.
* **Resolved Architecture (DOM-Injected Token + Same-Origin Policy Confinement)**:
  1. The server renders the HTML shell via `renderPanel()` and injects the private bridge token directly into the client context:
     ```html
     <script>window.__ISYMCP_TOKEN__ = "BRIDGE_TOKEN_VALUE";</script>
     ```
  2. Under the browser **Same-Origin Policy (SOP)**, external web pages cannot read the DOM of `http://127.0.0.1:8798`.
  3. The frontend JavaScript (`src/panel-chat.ts`) includes `x-isymcp-token: window.__ISYMCP_TOKEN__` on all mutating API calls.
  4. All mutating backend endpoints (`/api/action`, `/api/harness/apply`, `/api/chats/*`, `/api/settings/*`) enforce `guardLocalRequest(req, { requireToken: true, requireJsonBody: true, loopbackOnly: true })`.
  5. Read-only endpoints (`GET /`, `GET /fragment`, `/assets/*`) remain accessible without headers.
  6. **Strategic Horizon (v2.0)**: Consolidate panel routes directly into `src/server.ts:8791/panel` to eliminate dual daemon overhead.

### Contradiction 2 (Decision B): Extensible Toolchain vs. Public Tunnel Zero-Trust
* **Conflict**: Utility tools (`media_*`, `comfyui_*`) were registered without session tokens to allow easy discoverability. However, exposing them over the public Cloudflare tunnel allows remote prompt injections to download 500 MiB files or saturate local GPUs without session authorization.
* **Flaw of Initial Direction (Mandating `turn_token` in Tool Input Schemas)**:
  * Mandating `turn_token` inside the parameter schema of `media_import` completely breaks OpenAI Custom GPT Actions. Custom GPT schemas in OpenAI's builder are static, and ChatGPT client models do not have internal developer turn tokens for media tools.
  * Changing input schemas requires manual re-publishing of Custom GPTs and breaks end-user workflows.
  * "Metadata" tools (`audio_scan`, `video_contact_sheet`) spawn heavy `ffmpeg` processes that DoS host CPU/RAM even if download tools are gated.
* **Resolved Architecture (Transport-Level Capability Masking)**:
  1. Segregate tool registration at the transport layer: when running on public Cloudflare tunnel MCP transports, do **not** register `media_*` or `comfyui_*` tools by default.
  2. The public tunnel MCP transport registers strictly the 8 authorized Codex workspace tools.
  3. Auxiliary tools remain accessible locally via CLI (`isymcp media prepare`), panel web UI, or local agent harnesses.
  4. If an operator explicitly opts in via `CODEX_WEB_HTTP_EXPOSE_AUX_TOOLS=true`, mutating media tools strictly enforce write confinement to the active session workspace (`session.cwd`), preventing writes to global `~/.codex-web-http/media`.

### Contradiction 3 (Decision C): Execution Continuity vs. Immediate Cascade Revocation
* **Conflict**: Background execution tasks (`codex_exec` with `background: true`) must survive across prompt turns without terminating prematurely. However, decoupling processes from the session registry leaves orphaned background processes executing on the host after an operator revokes the session.
* **Flaw of Initial Direction (Separating Auth Invalidation from Eventual Process Cleanup)**:
  * Allowing a 30-second sweeper delay creates an unacceptable window: malicious exfiltration or resource destruction commands (which execute in 2–4 seconds) finish long before the sweeper wakes up.
  * Relying on `proc.kill(9)` in Bun/Node on Windows only terminates `cmd.exe`, leaving child processes (`curl`, `python`, `git`) running as immortal background zombies.
  * In-memory `LiveExec` checks do not prevent TOCTOU races with `codex_write_stdin`.
* **Resolved Architecture (Synchronous Pre-Execution Validation + OS Process Tree Termination)**:
  1. **Canonical Root Session Indexing**: In `src/mcp/main.ts`, index `LiveExec` by `rec.sessionFp = session.parent ?? session.fp`.
  2. **Synchronous Fail-Closed Verification**: In `findLive(id)` and `runWriteStdin()`, verify that `rec.sessionFp` exists and is unexpired in `codex-sessions.json` on disk (< 0.2 ms). If revoked or missing, terminate immediately and return `fail("session_revoked")`.
  3. **Sub-Second Fast Sweeper & Invalidation Reconciliation**: In `src/mcp/exec-registry.ts`, reconcile the active live map against disk during sweeps and terminate unreferenced processes.
  4. **Cross-Platform Tree Termination**: On Linux, terminate process groups via `process.kill(-pid, "SIGKILL")`. On Windows, terminate descendant trees via `stopProcessTree(pid)` (`taskkill.exe /F /T /PID <pid>`).

---

## Goals vs. Non-Goals

### In-Scope Goals
* **G1: Administrative Plane Protection**: Enforce mandatory token verification via DOM-injected token and SOP on all mutating endpoints in `src/panel.ts`.
* **G2: Public Tunnel Capability Masking**: Omit auxiliary tools (`media_*`, `comfyui_*`) from public tunnel MCP transports by default; require opt-in and directory confinement.
* **G3: Synchronous Cascade Process Termination**: Enforce pre-execution session validation and process tree termination (`stopProcessTree`) across Linux and Windows upon session revocation.
* **G4: Cross-Turn Process Management**: Index background processes by canonical root session fingerprint, enabling multi-turn workflows to control background tasks safely.
* **G5: Internal CLI Header Consistency**: Fix `isymcp ask` and `isymcp settings` to attach `bridgeAuthHeaders()` across all internal daemon calls.
* **G6: Path Validation Realpath Hardening**: Replace `resolveWithin` with `resolveWithinReal` in `runApplyPatch` to prevent potential symlink traversal.
* **G7: Negative Adversarial Test Suite**: Add automated tests covering unauthenticated panel actions, session revocation cascades, and invalid token rejections.

### Out-of-Scope Non-Goals
* **NG1**: Rewriting the Bubblewrap or Docker container isolation model.
* **NG2**: Modifying the official Codex protocol-5 desktop broker contract.
* **NG3**: Redesigning the Playwright browser automation or ChatGPT web DOM adapter.
* **NG4**: Replacing Bun runtime dependencies or eliminating Cloudflare tunnel infrastructure.

---

## Alternatives Weighed

1. **Alternative 1: Ephemeral URL Query Ticket exchanged for HttpOnly Cookie**
   * *Status*: **Rejected by Adversarial Review**. Leaks in process tables (`ps aux`, `/proc/*/cmdline`), breaks bookmarks, browser refresh (`F5`), and server restarts. Replaced by DOM injection + SOP.
2. **Alternative 2: Mandating `turn_token` in Tool Parameter Schemas**
   * *Status*: **Rejected by Adversarial Review**. Breaks ChatGPT Custom GPT action schemas and consumer UX. Replaced by transport-level capability masking.
3. **Alternative 3: Eventual Process Cleanup via 30s Sweeper Only**
   * *Status*: **Rejected by Adversarial Review**. Leaves a 30s vulnerability window and leaks zombie child processes on Windows. Replaced by synchronous pre-execution validation and OS process tree termination (`stopProcessTree`).

---

## Key Decisions & Staging for Next Steps

### Key Technical Decisions
* **Decision 1**: Enforce `requireToken: true` for mutating routes on `panel.ts`, authenticated via DOM-injected token (`window.__ISYMCP_TOKEN__`) protected by SOP.
* **Decision 2**: Mask `media_*` and `comfyui_*` tools on public tunnel MCP transports by default (`CODEX_WEB_HTTP_EXPOSE_AUX_TOOLS=false`).
* **Decision 3**: Index `LiveExec` by root parent fingerprint, enforce synchronous revocation checks on `findLive` and `runWriteStdin`, and execute OS process tree termination (`stopProcessTree`).
* **Decision 4**: Provide a rollback configuration flag: `CODEX_WEB_HTTP_SECURITY_PROFILE=strict|v1_compat` (default: `strict`).

---

## Roadmap Staging

- **Milestone 0**: CLI client authentication consistency (`isymcp.ts`).
- **Milestone 1**: Panel loopback token enforcement and DOM-injected SOP token transport (`panel.ts`, `panel-chat.ts`).
- **Milestone 2**: MCP tool capability envelope and transport-level auxiliary tool masking (`mcp/main.ts`, `media/register.ts`, `comfyui/register.ts`).
- **Milestone 3**: Synchronous background execution cascade termination and multi-turn root parent fingerprint indexing (`exec-registry.ts`, `mcp/main.ts`).
- **Milestone 4**: Adversarial test harness and CI regression checks (`tests/security-boundary.test.ts`).
