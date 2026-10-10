# Guided YouTube CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user paste a public YouTube URL, choose an output folder, review metadata, confirm the download, and receive a verified media-analysis package while preserving the private catalog entry.

**Architecture:** Keep `isymcp media prepare <url>` unchanged and add an injectable guided path for `media prepare` without a URL plus a TUI action. Separate metadata/picker, package export, and flow orchestration so the user can test each boundary without network access. Add process-level E2E coverage using temporary homes and fake external commands.

**Tech Stack:** TypeScript, Bun, `bun:test`, existing `MediaCatalog`/`MediaImporter`/`MediaPreparationStore`, yt-dlp, Linux `zenity` or `kdialog` when already installed.

**Spec:** [`docs/superpowers/specs/2026-10-09-guided-youtube-cli-design.md`](../specs/2026-10-09-guided-youtube-cli-design.md)

## Global Constraints

- First release supports Linux; use installed `zenity` or `kdialog`, and never install a picker automatically.
- Keep the existing scriptable `isymcp media prepare <url>` behavior and compact JSON output.
- Use public individual YouTube video/Short URLs only; no cookies, plugins, config files, cache, playlists, live streams, or authenticated downloads.
- Preserve the existing 500 MiB and 30-minute media limits and use the existing import, catalog, and preparation pipeline.
- Do not download before the user confirms; canceling URL, picker, or confirmation must not start an import.
- Keep the private media catalog as source of truth; export is an additional copy and must not add arbitrary-path MCP access.
- Never overwrite an existing package. Verify copied source/artifact SHA-256 values before finalizing the export; preserve the private catalog if export fails.
- Create the partial package directory under the selected parent so it is on the same filesystem. Publication must be atomic and no-replace; if that guarantee is unavailable, fail closed and preserve the partial package.
- Record the canonical YouTube URL/ID, downloader-confirmed ID, registered source URL, downloaded source SHA-256/bytes, and actual probed duration/streams. Compare preview and downloaded metadata when both are available; never guess missing values.
- Demonstrate the local-to-MCP recovery path through the real MCP protocol: prepare, look up by URL, recover the saved audio scan and a timestamped contact sheet through registered tools, and verify the same asset ID/hash. A real GPT.com canary is a separate external check; report it as `NOT_DEMONSTRATED` if this session cannot invoke the connected MCP.
- Contact sheets show ordered, timestamped samples only; they are not exhaustive frame extraction or video playback.
- Run command-boundary tests only in temporary homes/configs with fake external executables and generated fixtures; do not mutate the real tunnel, Codex config, harness config, sessions, or logs.

## Review Focus

- A YouTube title with path separators, control characters, dot segments, or reserved names must produce a safe package path; pin this in Task 2.
- A title/size/duration missing from yt-dlp metadata must be shown as unavailable without guessed values; pin this in Task 1.
- Canceling the native picker or metadata confirmation must never call the importer; pin this in Task 3.
- Two concurrent exports targeting the same package name must produce exactly one published package and one collision, never overwrite; pin this in Task 2.
- Missing picker binaries or a picker returning an error must stop with an actionable message and no download; pin this in Task 1.

---

### Task 1: Safe YouTube metadata preflight and Linux folder picker

**Files:**
- Create: `src/media/preview.ts`
- Modify: `src/media/youtube.ts` only if shared yt-dlp command construction is needed
- Test: `tests/media-preview.test.ts`

**Interfaces:**
- `YouTubePreview = { url: string; video_id: string; title?: string; uploader?: string; duration_seconds?: number; resolution?: string; estimated_bytes?: number }`.
- `inspectYouTube(input: string, runner?: typeof run): Promise<YouTubePreview>` canonicalizes with `youtubeSource`, invokes yt-dlp in metadata-only mode, requires yt-dlp's `id` to match the canonical ID, and maps absent optional fields to `undefined`.
- `chooseOutputDirectory(options?: { platform?: NodeJS.Platform; runner?: typeof run; env?: NodeJS.ProcessEnv }): Promise<string | null>` returns the selected directory, `null` on cancel, and a safe error if no supported picker exists.
- Both functions use injected process execution so tests do not call the network or display a real dialog.

- [ ] **Step 1: Add failing tests for metadata parsing and safe process arguments.** Assert the canonical URL is passed, download is skipped, unsafe yt-dlp config/plugins/cache are disabled, output fields map correctly, missing metadata stays undefined, metadata IDs must match the canonical URL, and untrusted terminal control characters are removed.
- [ ] **Step 2: Run `bun test tests/media-preview.test.ts` and verify the new tests fail because the interfaces are absent.**
- [ ] **Step 3: Add the metadata-only yt-dlp wrapper in `src/media/preview.ts`.** Use `youtubeSource` before spawning, parse one JSON object, bound output, and reject malformed output without exposing provider stderr or local paths.
- [ ] **Step 4: Add picker tests for zenity success/cancel, kdialog success/cancel, missing binaries, and dialog error.** Assert no shell interpolation and that cancellation returns `null`.
- [ ] **Step 5: Implement `chooseOutputDirectory` for Linux.** Resolve only installed binaries from the injected PATH; use argument arrays with `run`; report an actionable missing-dependency error.
- [ ] **Step 6: Run `bun test tests/media-preview.test.ts` and verify all cases pass.**
- [ ] **Step 7: Commit Task 1** with `git add src/media/preview.ts src/media/youtube.ts tests/media-preview.test.ts && git commit -m "feat: add guided media preflight" -- src/media/preview.ts src/media/youtube.ts tests/media-preview.test.ts`.

### Task 2: Atomic, hash-verified media package export

**Files:**
- Create: `src/media/export.ts`
- Test: `tests/media-export.test.ts`

**Interfaces:**
- `PackageExportResult = { directory: string; manifest_path: string; manifest_sha256: string }`.
- `PackageCollisionError` signals that the intended final package directory already exists.
- `exportMediaPackage(catalog: MediaCatalog, asset: Asset, manifest: PreparationManifest, store: MediaPreparationStore, parentDirectory: string, preview: YouTubePreview): Promise<PackageExportResult>` copies only the verified source and ready-generation artifacts.
- Export layout: `<safe-title> [<youtube-id>]/source.<original-extension>`, `manifest.json`, `audio-scan/<artifact-id>.json`, and `contact-sheets/<artifact-id>.jpg`.

- [ ] **Step 1: Add failing tests for package contents and hashes using a generated media file and a ready preparation fixture.** Assert source, audio scan, contact sheets, and package manifest hashes match their catalog/preparation metadata.
- [ ] **Step 2: Run `bun test tests/media-export.test.ts` and verify it fails because export is not implemented.**
- [ ] **Step 3: Implement safe title/YouTube-ID directory naming and a manifest that records canonical URL, asset ID, source SHA-256/bytes, media preview, preparation generation, pipeline versions, and hashes for every exported file.**
- [ ] **Step 4: Add tests for separators/control characters/reserved names, existing package collision, concurrent exports to the same name, same-filesystem staging, and injected copy/write/publisher failure.** Assert exactly one concurrent export can publish, collisions never overwrite, and failures do not claim success; retain any partial export location for recovery.
- [ ] **Step 5: Implement export in a unique partial directory created directly under the selected parent and finalize only with a guaranteed atomic no-replace operation.** On Linux, use an injected publisher backed by `mv -T -n -- <partial> <final>`; treat missing `mv`, unsupported no-clobber behavior, or an ambiguous result as failure. Verify the partial path disappeared and final manifest/hashes match before reporting success. Use catalog resolution and preparation-store reads so export never trusts unverified source or artifact paths.
- [ ] **Step 6: Run `bun test tests/media-export.test.ts` and verify all package, collision, and failure cases pass.**
- [ ] **Step 7: Commit Task 2** with `git add src/media/export.ts tests/media-export.test.ts && git commit -m "feat: export verified media packages" -- src/media/export.ts tests/media-export.test.ts`.

### Task 3: Interactive preparation flow with explicit confirmation

**Files:**
- Modify: `src/media/cli.ts`
- Modify: `tests/media-prepare-cli.test.ts`

**Interfaces:**
- Extend `MediaCommandDependencies` with injectable `promptUrl?: () => Promise<string | null>`, `chooseDirectory?: typeof chooseOutputDirectory`, `inspect?: typeof inspectYouTube`, `confirm?: (preview: YouTubePreview) => Promise<boolean>`, and `exportPackage?: typeof exportMediaPackage`.
- `mediaCommand('prepare', [], dependencies)` enters guided mode; `mediaCommand('prepare', [url], dependencies)` remains non-interactive and retains its current one-line JSON contract.
- The guided mode prompts for a valid URL, chooses a directory, displays preview fields and unavailable values, confirms, then reuses the existing import/prepare flow and exports only after a `ready` manifest.

- [ ] **Step 1: Add failing tests for guided success with injected prompt/picker/preview/confirm/export; assert exact order URL → picker → preview → confirm → import → prepare → export.** The package receipt preserves canonical URL/ID, downloader-confirmed ID, registered URL, source SHA-256/bytes, and actual probed metadata; compare preview fields only when both values exist.
- [ ] **Step 2: Add failing cancellation tests for URL prompt, picker, and confirmation; assert importer and exporter are never called and no success JSON is printed.**
- [ ] **Step 3: Add a collision test that re-prompts for a folder or lets the user cancel, without downloading the source a second time.** Add an identity-mismatch test proving a downloader-reported ID different from the canonical ID fails before registration/export; missing preview fields remain unknown.
- [ ] **Step 4: Run `bun test tests/media-prepare-cli.test.ts` and verify the guided cases fail before implementation while legacy tests remain green.**
- [ ] **Step 5: Implement guided orchestration by extracting the current import/prepare logic into a shared internal operation; keep the one-URL output shape unchanged and send interactive progress/summary to stderr/stdout respectively.**
- [ ] **Step 6: Verify both guided and legacy cases with `bun test tests/media-prepare-cli.test.ts`.**
- [ ] **Step 7: Commit Task 3** with `git add src/media/cli.ts tests/media-prepare-cli.test.ts && git commit -m "feat: guide users through media preparation" -- src/media/cli.ts tests/media-prepare-cli.test.ts`.

### Task 4: TUI entry point and command help

**Files:**
- Modify: `src/menu.ts`
- Modify: `src/isymcp.ts`
- Test: `tests/menu.test.ts`
- Test: `tests/cli-help.test.ts` (create if no focused help test exists)

**Interfaces:**
- Add visible menu id `media-prepare`, label `Preparar video de YouTube…`, under `USAR`.
- The action dispatches to the same guided `mediaCommand('prepare', [])` path; menu selection does not fork a second preparation pipeline.
- `help()` documents both `isymcp media prepare` and `isymcp media prepare <url>`.

- [ ] **Step 1: Add failing assertions that the new visible leaf maps to an action and help contains both guided and scriptable forms.**
- [ ] **Step 2: Run focused menu/help tests and confirm they fail on the missing leaf/action/help text.**
- [ ] **Step 3: Add the USAR leaf, dispatch handler, and help text.** Preserve existing menu behavior and error reporting.
- [ ] **Step 4: Test TTY menu navigation into the action using an injected guided flow or fake picker, and verify Esc/cancel exits without invoking the downloader.**
- [ ] **Step 5: Run `bun test tests/menu.test.ts tests/cli-help.test.ts` and verify they pass.**
- [ ] **Step 6: Commit Task 4** with `git add src/menu.ts src/isymcp.ts tests/menu.test.ts tests/cli-help.test.ts && git commit -m "feat: add guided media action to CLI menu" -- src/menu.ts src/isymcp.ts tests/menu.test.ts tests/cli-help.test.ts`.

### Task 5: Isolated process-level E2E coverage for CLI commands

**Files:**
- Create: `tests/cli-e2e.test.ts`
- Modify: `tests/e2e-all.test.ts` only to register the focused matrix if the current runner requires it
- Modify: `src/isymcp.ts` only where a narrow injectable environment seam is required for isolation

**Interfaces:**
- The test harness launches the real `src/isymcp.ts` entry point with a temporary `HOME`, `ISYMCP_MEDIA_HOME`, controlled ports, and temporary PATH containing fake bridge/tunnel/yt-dlp/dialog/browser commands.
- A table derived from `help()` and visible `MENU` leaves records each documented command path/action, its safe arguments, expected exit/result, and fake external effects.

- [ ] **Step 1: Add a failing E2E smoke test that launches `bun src/isymcp.ts --help`, `tree`, `media list`, and one visible menu leaf in a temporary HOME.** Assert the real process exits and leaves the host environment untouched.
- [ ] **Step 2: Add a table-driven command/menu matrix covering every help entry:** `status`, `menu`, `panel` and `panel start|stop|status|run`, `ask`, `up`, `down`, `server start|stop`, `tunnel connect|stop|status`, `models` and `models apply|restore`, `codex` and `codex launcher`, `command`, `tui list|install` including `--apply|--restore`, `session mint|list|revoke`, `canary status|schedule|unschedule`, `harness list|install|uninstall`, `health`, `metrics` including `--prom`, `smoke`, `logs` including `--last` and `export` date/output forms, and `media add|list|revoke|prepare`. Also invoke every visible menu leaf from `src/menu.ts`, using fake executables, temporary configs, dry-run, or cancel paths for external/persistent effects. Do not perform live canary turns, mutate the real Codex/harness config, revoke real sessions, or stop/connect the real tunnel.
- [ ] **Step 3: Add guided media E2E cases for URL rejection, picker/confirm cancellation, generated fixture download, registration, preparation, package export, collision, and hash verification.** Assert the existing one-URL CLI path still returns compact JSON.
- [ ] **Step 4: Add an MCP-protocol E2E using the actual stdio server and a temporary media catalog.** After guided preparation, call registered `media_lookup` by canonical URL, assert the same `asset_id`, `source_sha256`, and `status: ready`, then retrieve the saved full `audio_scan` and one timestamped contact sheet through authorized tools. Assert there is no arbitrary-path input and label contact-sheet frames as samples.
- [ ] **Step 5: Run `bun test tests/cli-e2e.test.ts tests/media-mcp.test.ts --timeout 30000`; verify every matrix entry and the MCP recovery sequence pass under isolated state.**
- [ ] **Step 6: Add any narrowly required environment injection to the CLI, then rerun the matrix and assert the real HOME, Codex config, tunnel, sessions, and logs are unchanged.**
- [ ] **Step 7: Commit Task 5** with `git add tests/cli-e2e.test.ts tests/e2e-all.test.ts src/isymcp.ts tests/media-mcp.test.ts && git commit -m "test: exercise CLI commands in isolated E2E harness" -- tests/cli-e2e.test.ts tests/e2e-all.test.ts src/isymcp.ts tests/media-mcp.test.ts` (omit unchanged paths from both commands).

### Task 6: User guide and complete verification

**Files:**
- Modify: `GUIA.md`
- Modify: `README.md` only if it currently documents the `media prepare` command
- Test: `tests/media-preview.test.ts`, `tests/media-export.test.ts`, `tests/media-prepare-cli.test.ts`, `tests/menu.test.ts`, `tests/cli-e2e.test.ts`

**Interfaces:**
- Document the menu action, guided `isymcp media prepare` flow, existing URL form, picker requirements, preview/confirmation, package layout, private catalog behavior, and cancellation/failure recovery.
- Include only output observed from a successfully executed local fixture flow; do not present fixture metadata as a real YouTube result.
- State explicitly that contact sheets show timestamped samples, not every frame.
- Report separately (1) package hash verification, (2) local MCP recovery, and (3) actual GPT.com tool invocation. Mark the third `DEMONSTRATED` only when a real remote call returns the prepared asset; otherwise record `NOT_DEMONSTRATED` and the missing connection.

- [ ] **Step 1: Add guide assertions for guided and scriptable command forms, Linux picker requirement, package contents, and catalog preservation.**
- [ ] **Step 2: Update `GUIA.md` with the tested flow and verified sample output.**
- [ ] **Step 3: Run focused media/menu/E2E tests, then `bun test --timeout 30000` and `bun src/isymcp.ts smoke`.** Record exact pass/skip/failure results; do not claim all commands pass if a matrix entry is unavailable.
- [ ] **Step 4: Run one authorized real GPT.com canary through the connected Codex ISyMCP MCP, asking it to call `media_lookup` for the canonical prepared-media URL and then retrieve authorized artifacts.** Capture actual tool results; if no callable remote connector exists, record `NOT_DEMONSTRATED` instead of substituting a local simulation.
- [ ] **Step 5: Review `git diff --check`, verify the current catalog and real user configuration were untouched, and inspect every changed path.**
- [ ] **Step 6: Commit Task 6** with `git add GUIA.md README.md tests/media-preview.test.ts tests/media-export.test.ts tests/media-prepare-cli.test.ts tests/menu.test.ts tests/cli-e2e.test.ts && git commit -m "docs: document guided YouTube preparation" -- GUIA.md README.md tests/media-preview.test.ts tests/media-export.test.ts tests/media-prepare-cli.test.ts tests/menu.test.ts tests/cli-e2e.test.ts` (stage only files that actually changed in this task).
