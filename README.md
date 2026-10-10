<div align="center">

# ISyMCP

**Your ChatGPT subscription as a local chat, an HTTP API, and a verified tool for your other coding agents.**

No API key. No Electron. Everything listens on `127.0.0.1`; the only thing that leaves your machine is the conversation with chatgpt.com.

[![CI](https://github.com/DannyBaanks/chatgpt-http-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/DannyBaanks/chatgpt-http-mcp/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-7cff9b)
![Runtime: Bun](https://img.shields.io/badge/runtime-bun%201.4-111)
![Local only](https://img.shields.io/badge/listens%20on-127.0.0.1-111)

<img src="docs/images/chat-tools.png" alt="ISyMCP chat: a ChatGPT answer with two tool cards (codex_exec, exit 0 and exit 1) taken from the execution trace" width="900">

<sub>Screenshots use demo data, regenerated with <code>bun run scripts/readme-screenshots.ts</code>.</sub>

</div>

---

## What you get

### 💬 A real chat, on localhost with Live Thinking Stream
`isymcp panel` opens a chat at **http://127.0.0.1:8798**. Each chat in the sidebar is its **own real ChatGPT conversation**, and you watch the answer **while ChatGPT is still writing it**: lists, code blocks, links, and animated, collapsible thought/reasoning boxes in real time.

<img src="docs/images/chat-live.png" alt="Live answer streaming with a blinking cursor and a running tool card" width="900">

### 🛠️ Tools you can actually verify
Turn on **Codex ISyMCP** in a chat and ChatGPT can run commands in a folder you choose, inside a `bubblewrap` sandbox. Every card above an answer comes from the **execution trace**: what really ran, its exit code and how long it took. It is not the model's account of what it did.

When something fails, the card says **who** failed: OpenAI blocked it, your ChatGPT session expired, Chrome crashed, or the local bridge didn't finish.

<img src="docs/images/chat-blocked.png" alt="Error card: 'Bloqueado por OpenAI — nothing ran on your machine'" width="900">

### 🎬 Local audio & video analysis
Import a public YouTube video/Short or register a local file, then inspect **timestamped frames, contact sheets, audio activity segments, waveforms, spectrograms and stereo channels**. The Codex ISyMCP media tools use reusable asset IDs and return verifiable measurements—not invented transcripts or sound identification. [Explore the media tools](#local-media-mcp).

### 🟢 Isolated & Decoupled Codex Profiles
No more mutating your global `~/.codex/config.toml`! ISyMCP provides isolated, side-by-side environments:
- **Native Codex (`codex`)**: talks directly to OpenAI, completely independent of the bridge.
- **ISyMCP Codex (`codex-isymcp` / `isymcp codex`)**: launches with dynamic, ephemeral `-c openai_base_url=http://127.0.0.1:8791/v1` and desktop entry.

### 🤝 ChatGPT inside your other agents (9 Harnesses Ready)
`chatgpt_ask` is an MCP tool. It lets **Claude Code, Codex, Cursor IDE, OpenCode TUI, GitHub Copilot CLI, Hermes Agent, OpenClaw, Pi, and Gemini CLI** ask *your* ChatGPT (GPT-5.6 Sol, your plan) for a second opinion halfway through a task.
- **CLI Strategy (`mcp add`):** Claude Code, Codex, Copilot, Hermes, OpenClaw, Pi, Gemini, Grok, Qwen.
- **Declarative JSON Strategy:** Cursor IDE (`~/.cursor/mcp.json`) and OpenCode TUI (`~/.config/opencode/opencode.json`).

<img src="docs/images/harnesses.png" alt="Harness list: claude and codex connected, qwen and gemini selected, with the exact install commands shown before confirming" width="900">

### 📊 Real-time Telemetry & Prometheus Metrics
Track latency distributions (min/avg/max), token estimates (including reasoning tokens), error taxonomies, and RSS/Heap memory in real time via `isymcp metrics`, `/api/metrics`, and native Prometheus `/metrics` endpoint.

### 📟 Status & Diagnostics Dashboard
Server, tunnel, MCP and browser health, the latest soak test turn by turn, the daily canary (with a **Run canary** button), sessions and their expiry, **Codex tasks**, and automated E2E smoke tests (`isymcp smoke`).

<p align="center">
  <img src="docs/images/status.png" alt="Status dashboard: everything online, latest soak 9/10" width="640">
  &nbsp;
  <img src="docs/images/mobile.png" alt="The chat on a phone-sized screen" width="190">
</p>

---

## Quickstart

```bash
bun install
bun link                      # puts `isymcp` on your PATH

# 1. Import your ChatGPT session once (keep the cookie file chmod 600)
bun run scripts/import-cookies.ts --file /path/to/cookie.txt

# 2. Start the bridge and open the panel
isymcp server start
isymcp panel                  # starts it in the background and opens http://127.0.0.1:8798
```

Then go to **Chat → Nuevo chat**, type, and the answer streams in. Or stay in the terminal: `isymcp ask "hola"`. Not sure what to type? Run `isymcp` alone: it opens a menu with every action.

### Optional extras:

```bash
isymcp tunnel connect                              # lets ChatGPT call the local tools (Codex ISyMCP)
isymcp session mint --cwd ~/projects/app --write   # a folder ChatGPT may work in
isymcp harness install claude cursor opencode      # plan only; add --apply to install chatgpt_ask
isymcp codex launcher                              # installs ~/.local/bin/codex-isymcp & desktop entry
isymcp smoke                                       # automated end-to-end sanity verification
```

**Model and reasoning.** The web transport uses whatever your ChatGPT account has selected. In the chat's side panel, **Verificar** shows what ISyMCP sees (for example `GPT-5.6 Sol · High (3/3)`). **Sincronizar ajustes** opens a visible Chrome with your session: you set the model and reasoning by hand, close the window, and that becomes the bridge's default.

*Note on Reasoning Traces vs Internal CoT:* The captured thinking (`reasoning_content` in API / thought boxes in the panel) represents the **visible summary and UI-rendered thoughts** exposed by ChatGPT Web's DOM. Capturing this DOM presentation is NOT equivalent to obtaining the model's full, raw latent internal Chain-of-Thought tokens. We document and stream strictly what is visibly presented on screen.

📖 **Human Operator Guide (Spanish):** For comprehensive step-by-step instructions, see [`GUIA.md`](GUIA.md).

---

## Limitations & risks — read before using

> [!WARNING]
> **RISK: HIGH — this is an unsupported use of ChatGPT Web.** ISyMCP drives the consumer chatgpt.com interface with a headless browser and reads answers from the page. OpenAI's [Terms of Use](https://openai.com/policies/row-terms-of-use/) forbid automatically or programmatically extracting data or output, and OpenAI can suspend accounts that break them. **Your account is what's at stake.** We don't claim a legal reading either way. If you need something supported and stable, use the official API.

- **UI thoughts vs full internal reasoning.** Captured thoughts are DOM summaries presented by the web interface, not the raw latent CoT tokens of the underlying model.
- **It breaks when chatgpt.com changes.** Answers are read from the page. A redesign can break capture. Failures produce a sanitized DOM dump in `~/.codex-web-http/run/capture-fail-*`.
- **`chatgpt_ask` answers are untrusted content**, like a web page. ChatGPT may have read hostile pages, and its answer lands in another agent's context, and that agent may have its own shell or write tools. Every answer carries an untrusted-content marker. Don't let an agent take side-effect actions (write, shell, push, delete) based only on it without your approval.
- **Tools inside ChatGPT.** A page ChatGPT reads could try to make it run commands. With bubblewrap enabled, the host filesystem is mounted read-only; the user's home and the bridge's secrets directory are hidden, then the session folder is re-exposed read-only or writable according to the session. System files outside that folder can still be read; this is not a filesystem restricted to that folder. Network access is disabled **by default**; `CODEX_WEB_HTTP_SANDBOX_NET=1` enables it. In a `--write` session, damage inside the session folder is possible. Prefer read-only sessions. Explicitly setting `CODEX_WEB_HTTP_SANDBOX=off` lets writable sessions run without bubblewrap.
- **The untrusted-content marker is advisory.** It labels bridge responses, including provider errors and HTTP diagnostics. It does not enforce approval or prevent prompt injection; the receiving agent must respect the user's existing authorization and its own permission controls.
- **Your ChatGPT cookies are the crown jewel.** They sit in `~/.codex-web-http/` with 0600 permissions, which stops other users but not malware or any process running as you.
- **Slow and serial.** One account, one tab, one turn at a time, each taking about 20–60 s. This is not a throughput replacement for an API.
- **Linux only** for tools (bubblewrap). Chat and the API need Chrome.

---

## How it works

```
your browser ──► isymcp panel (:8798) ─┐
OpenAI-compatible clients ─────────────┼──► bridge (:8791) ──► headless Chrome ──► chatgpt.com
other agents ──► MCP isymcp-chatgpt ───┘          │
                                                  ├─ live thinking ──► streaming SSE (reasoning_content)
                                                  ├─ compaction ──────► automatic context pruning (>40 msgs)
                                                  └─ tools: chatgpt.com ─► tunnel ─► MCP stdio ─► bwrap sandbox
```

- **Bridge** (Bun): drives one persistent ChatGPT tab. Turns are **serialized** (one at a time, in order), so chats never write into each other. It reads the answer from the page as ChatGPT writes it, and rebuilds the Markdown.
- **Live Thinking Stream**: extracts thinking bubbles dynamically and exposes them via SSE `delta.reasoning_content` and panel UI cards.
- **Context Compaction**: automatically prunes multi-turn conversations exceeding 40 messages, preserving the initial prompt/goal, inserting a context note, and retaining the recent message window.
- **Chats**: chat id → canonical `chatgpt.com/c/…` URL, stored in `~/.codex-web-http/chats/` (0700/0600). The browser only ever sends a chat id and your text; it never decides which conversation to open.
- **Tools**: each tool turn gets a **one-off token**. It inherits the folder and read/write mode of the session you picked, lives 15 minutes and is **revoked when the turn ends**. Only that token goes to chatgpt.com. The MCP logs every call under that token's fingerprint, and the tool cards are read back from that log.
- **Reviver**: if Chromium crashes mid-turn, the bridge relaunches it and re-reads the answer that was already generated. It never sends the turn twice.
- **Never Guess**: an answer only counts if it provably belongs to *this* turn (the last assistant turn changed identity, or its text changed). Otherwise the turn fails with a DOM dump. The bridge never returns the previous answer or "whatever looks closest".
- **Canary**: `isymcp canary` runs three real turns in one dedicated chat (echo A, echo B without A, Markdown capture). `isymcp canary schedule --apply` runs it daily and sends a desktop notification on failure.
- **Smoke Suite**: `isymcp smoke` runs unified end-to-end verification of health, metrics, harnesses, and isolated launchers.

<details>
<summary><b>Chat details</b></summary>

- Only the **new** message is sent each turn; ChatGPT already holds the context.
- Live text: the bridge re-reads the page about every 0.4 s, and each update replaces the whole partial answer.
- Markdown goes through a renderer that escapes everything first, so model HTML never reaches the page.
- Tools are **off** in every new chat. The session picker shows fingerprint, folder, read/write and expiry, never the token.
- The OpenAI-compatible route `/v1/chat/completions` keeps its own contract (full transcript) and its own conversation.
</details>

---

## Use it as an HTTP API

```bash
curl -s http://127.0.0.1:8791/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"chatgpt-web/gpt-5.6-sol","messages":[{"role":"user","content":"hola"}]}'
```

- `POST /v1/chat/completions` (models `chatgpt-web/*`), plus native passthrough for `/v1/responses`, `/v1/models` and the websocket.
- **Idempotency**: send `x-isymcp-turn-id`. A replay returns the same response (`x-isymcp-replayed: 1`) without running the model again.
- **Typed errors** mapped to HTTP status (400/401/403/409/415/502/503/504). See [`docs/PROTOCOL.md`](docs/PROTOCOL.md).
- **Telemetry Endpoints**: `GET /api/health`, `GET /api/metrics` (JSON), and `GET /metrics` (Prometheus/OpenMetrics).

---

## Local media MCP

Process explicitly registered audio and video locally, then inspect the evidence from **Codex ISyMCP** or a separate media MCP entry point. Media queries use an opaque `asset.id` and **do not require a Codex turn token**. Audio analysis measures signals; it does **not** provide native listening, transcription, speaker recognition or voice/music separation.

### Quick workflow

| Start with | What to do |
|---|---|
| **Local file** | Register it with `bun src/isymcp.ts media add <file>`; keep the returned asset ID. |
| **Prepare a reusable YouTube analysis** | Run `isymcp media prepare` (or `bun src/isymcp.ts media prepare`) to paste a URL, choose a folder, review metadata and confirm before download. It creates a hash-verified package and keeps the private catalog. |
| **Script an existing flow** | Keep using `isymcp media prepare <url>` for the existing noninteractive JSON command; it does not open the picker or export a package. |
| **Look up a YouTube source in ChatGPT** | Call read-only `media_lookup(url)` first. If it is `ready`, inspect its stored audio results and request one relevant sheet with `sheet_index`; `not_found` and `not_prepared` never download or analyze. |
| **One-off public YouTube video or Short** | Call `media_import(url)`, poll `media_import_status(job_id, wait_seconds: 10)` until `complete`, and use `asset.id`. |
| **Inspect video** | Use `media_info`, `video_contact_sheet` for an overview and `video_frame` for a specific timestamp. |
| **Inspect audio** | Use `audio_scan` to scan the complete track in chunks of at most 120 seconds, then `audio_analyze` to zoom into a selected waveform, spectrogram or stereo measurement. |

For step-by-step commands and the verified ChatGPT prompt, see **[GUIA.md — Medios locales](GUIA.md#medios-locales-audio-y-video-2026-10-09)**.

### Local execution, entry points & limits

The independent `src/mcp/media.ts` entry point processes only explicitly registered local assets. The main **Codex ISyMCP** entry point exposes the media tools alongside its existing `codex_*` tools; both share `src/media/register.ts`. `media_list` discovers only user-registered assets, paginated in groups of 20. `media_lookup` resolves only a canonical public YouTube URL already in the catalog and never starts work. Codex session authorization and sandbox behavior remain enforced.

Both MCP entry points publish the bundled ISyMCP PNG through `serverInfo.icons` during initialization. ChatGPT or another MCP client may need to reconnect after upgrading the server before it refreshes the icon and tool catalog.

Audio activity windows, channel-aware waveforms, spectrograms, RMS, peaks and silence intervals run locally through **FFmpeg/ffprobe**. Video frames use a separately installed MIT **Video Vision** provider configured through `ISYMCP_VIDEO_VISION_ENTRY` (absolute `dist/index.js`) and optionally `ISYMCP_VIDEO_VISION_NODE`. Requires Bun and FFmpeg/ffprobe.

Original files remain local and read-only; requested images and statistics are returned to the MCP client. Limits: **500 MiB per file**, **120 seconds per audio window**, **60 seconds for ordinary queries**, **300 seconds for full-track `audio_scan`**, **one concurrent job** and **1 MiB per output image** (up to four images for separated stereo). Neither entry point provides an arbitrary filesystem path tool or audio transcription.

`media prepare` stores versioned manifests, verified audio-scan JSON and consecutive contact sheets privately under the media catalog. Audio is segmented in chunks of at most 120 seconds; video is sampled in gapless windows of at most 60 seconds. Failed runs can resume verified partial outputs, and only a complete generation becomes current. A later `media_lookup` returns the saved scan and sheet index; each call transfers at most one JPEG. Acoustic segments are energy measurements, not speech recognition or native listening.

The guided command exports a second copy only after the local preparation is `ready`. It records the canonical source and downloader-confirmed video ID, hashes the original and every artifact, stages under the selected destination filesystem, and publishes with an atomic no-replace operation. Existing packages are never overwritten. The contact sheets are chronological samples, not exhaustive frame extraction.

The MCP itself is a tool server, not a standalone chat model. The selected ChatGPT model produces the conversational response and decides when to call tools. Media tools do not require `turn_token`; `codex_*` execution tools require a real token from `isymcp session mint --cwd <directory>` and the explicit `COMANDO: @CODEX ISYMCP` marker. `codex_turn_start` consumes the supplied token; it does not mint one.

The standalone media stdio entry point has local compatibility coverage. Remote GPT.com calls documented below used the main Codex ISyMCP connection; they do not establish remote E2E compatibility for every standalone media tool.

### YouTube URL imports

`media_import(url)` starts an asynchronous local download of an individual public YouTube video or Short; `media_import_status` reports progress. **yt-dlp** is sourced from the Video Vision installation, `PATH` or `ISYMCP_YTDLP_BIN`, without browser cookies, configuration or plugins. Video Vision supplies frames and FFmpeg supplies audio graphics and measurements.

Import limits: **500 MiB**, **30 minutes**, a **180-second import deadline**, and one shared download/analysis worker. Sources and SHA-256 are recorded. Completed downloads persist; partial files are retained, while in-memory job status resets when the server restarts. See [GUIA.md](GUIA.md) for the verified Angel Engine import workflow.

### Video contact sheets

`video_contact_sheet(asset_id, start_seconds, end_seconds, columns?)` returns a single **1920 × 1080 JPEG** with chronological labelled frames and a timestamp/index map. Default layout: **4×4** (16 samples); **3×3** and **6×6** are also available. FFmpeg preserves aspect ratio.

The maximum interval is 60 seconds, under the shared worker/deadline and 1 MiB image cap. Sample times exclude the interval endpoint; requested seek times may differ from decoded frame timestamps. Use `video_frame` for details or a narrower interval for fast-changing scenes. **A contact sheet is a sampled overview, not video playback or OCR.**

### Audio segments, waveforms & stereo

`audio_scan(asset_id, start_seconds?, end_seconds?, chunk_seconds?, threshold_dbfs?, merge_gap_seconds?, min_segment_seconds?)` scans the complete audio track by default in chronological chunks of up to 120 seconds (`chunk_seconds` can be reduced to 1–120). It returns each chunk, acoustic activity segments with absolute source timestamps, effective parameters and a total segment count. The full scan has a 300-second deadline and returns measurements without images. Each chunk is segmented independently, so continuous activity can split at chunk boundaries. This measures acoustic energy, not speech, transcription or native listening.

`audio_segments(asset_id, start_seconds, end_seconds, threshold_dbfs?, merge_gap_seconds?, min_segment_seconds?)` finds activity intervals using **10 ms RMS windows on mono 16 kHz audio**. It accepts windows up to 120 seconds. `algorithm_version` identifies the segmenter independently of the `isymcp-media/1` response schema. Version `audio-rms-activity/2` uses these defaults:

| Parameter | Default |
|---|---:|
| `threshold_dbfs` | `-32` |
| `merge_gap_seconds` | `0.10` |
| `min_segment_seconds` | `0.12` |

Pass `merge_gap_seconds: 0.15` to reproduce the earlier six-segment grouping on the sample below. Segmentation detects **acoustic energy, not speech**: music, effects and noise can form segments, and quiet speech can be missed.

Use `audio_analyze` on a selected window to zoom into its waveform and spectrogram. The optional `channel` parameter is `mix` (default), `left`, `right` or `separate`. In stereo `separate` mode the tool returns independent left/right measurements and **four images** (L waveform, L spectrogram, R waveform, R spectrogram), plus Pearson correlation and L−R difference RMS/peak. These quantify channel similarity; they **do not separate voices, music or effects**. Source and analyzed channel counts are reported.

<details>
<summary><b>Reproducibility canary — Angel Engine Short (2026-10-09)</b></summary>

The public [Angel Engine Short](https://www.youtube.com/shorts/lHkDE3BahB0) was analyzed through Codex ISyMCP from GPT.com using the same registered asset and SHA-256. Default settings returned **eight intervals**; explicitly setting `merge_gap_seconds: 0.15` reproduced the **six earlier intervals**. Both responses reported `isymcp-media/1`, `audio-rms-activity/2` and effective parameters.

| `merge_gap_seconds` | Activity intervals (seconds) |
|---:|---|
| `0.10` (default) | `0.17–1.49`, `1.72–2.41`, `2.65–2.80`, `3.15–4.30`, `4.43–5.72`, `6.13–6.42`, `6.93–8.00`, `8.13–9.992` |
| `0.15` | `0.17–1.49`, `1.72–2.41`, `2.65–2.80`, `3.02–5.72`, `6.13–6.62`, `6.93–9.992` |

A reported `audio_analyze(channel="separate")` call over seconds 3–5 measured Pearson correlation **0.9958708812**, L−R difference RMS **0.0140555501**, and difference peak **0.1249013543**. This shows similar, non-identical channel signals; it cannot identify or separate sources.

The protocol report is user-provided rather than a captured raw protocol transcript; segment RMS/peak values were said to match but were not included in that report. See the [E2E report](docs/evidence/audio-segments-gptcom-e2e-user-report-20261009.json), [local test log](docs/evidence/audio-segment-versioned-tests-20261009.txt), and [version manifest](docs/evidence/audio-media-final-manifest-20261009.sha256).

</details>

---

## CLI Reference

| Command | Description |
|---|---|
| `isymcp` | Interactive menu with everything below (or prints status when piped) |
| `isymcp panel` | Opens the chat + status panel on :8798 (detached); `panel start` / `stop` / `status` / `run` |
| `isymcp ask "text" [--new]` | Real ChatGPT turn from the terminal; keeps one terminal chat, stdin works too |
| `isymcp codex [args...]` | Runs Codex with isolated ISyMCP web profile (without mutating `config.toml`) |
| `isymcp codex launcher` | Installs desktop entry `Codex (ISyMCP Web)` and `~/.local/bin/codex-isymcp` |
| `isymcp up` / `down` / `status` | Server + tunnel lifecycle and honest status |
| `isymcp server start` / `stop` | Starts or stops the HTTP bridge |
| `isymcp tunnel connect` / `stop` / `status` | MCP tunnel for ChatGPT tools |
| `isymcp session mint --cwd <dir> [--write] [--ttl h]` | Creates a scoped session folder (read-only by default, 7-day TTL) |
| `isymcp session list` / `revoke <fp>` | Audits or revokes tool session tokens |
| `isymcp harness list` | Lists detected coding agents and their `chatgpt_ask` installation status |
| `isymcp harness install` / `uninstall <ids\|--all> [--apply]` | Installs `chatgpt_ask` (dry-run plan by default, `--apply` writes) |
| `isymcp canary` / `canary status` | Real turn verification: capture, turn identity, Markdown |
| `isymcp canary schedule [--apply]` | Daily systemd user timer for automated regression alerts |
| `isymcp health` | Live health and diagnostic status of the bridge |
| `isymcp metrics [--prom]` | Real-time telemetry (turns, tokens, latencies, memory) or Prometheus format |
| `isymcp smoke` | Unified E2E verification suite (health, metrics, harnesses, launcher) |
| `isymcp logs` | Live bridge log viewer and exporter |

---

## Security model

- **Local only, for real.** The bridge and the panel bind `127.0.0.1` *and* reject foreign `Host`/`Origin` headers and non-JSON POSTs (protection against CSRF and DNS rebinding).
- **Token Authentication (`CODEX_WEB_HTTP_TOKEN`):** Required for any non-loopback exposure. Clients must send `Authorization: Bearer <TOKEN>` or `x-isymcp-token`.
- **Sandbox Isolation.** `bubblewrap` hides `$HOME` and the bridge's secret folder behind tmpfs, disables network access by default, and exposes only the selected session folder.
- **Session Tokens.** Tokens expire (7 days by default) and can be revoked. Only sanitized fingerprints (`sha256[:12]`) are stored in logs and UI.

---

## Verification & Testing

- **Full Test Suite:** **302 tests passing across 48 files** (`bun test`; verified locally on 2026-10-09).
- **Unified E2E Smoke:** Verified with `isymcp smoke` and `scripts/e2e-all.ts`.
- **Soak Testing:** 99/100 successful real turns in soak baseline; 9/10 with tool execution inside sandbox.
- **Canary:** Regular verification against live chatgpt.com DOM changes.

See [`docs/EVIDENCE.md`](docs/EVIDENCE.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

---

## License

MIT — see `LICENSE`. Derivative mechanics from MIT projects are credited in `NOTICE`.
