# Local Media Preparation and URL Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare a registered public video once on the user's computer and let ChatGPT retrieve its verified metadata, complete audio scan and saved contact sheets by URL.

**Architecture:** Add a private, versioned preparation store under the existing media catalog, an orchestrator that reuses `MediaCatalog.snapshot`, `audioScan` and `contactSheet`, a CLI `media prepare` flow that reuses existing imports, and read-only MCP `media_lookup`. Artifacts are fingerprinted and verified; ready manifests switch atomically, and incomplete generations resume without replacing the previous ready generation.

**Tech Stack:** TypeScript, Bun, existing MCP SDK/Zod registration, FFmpeg/ffprobe, Node filesystem and crypto APIs.

**Spec:** `docs/superpowers/specs/2026-10-09-local-media-preparation-design.md`

## Global Constraints

- Reuse the existing public YouTube URL validation and download policy; do not use browser cookies.
- Preserve the existing 500 MiB import limit and 30-minute media limit.
- Audio scan chunks are no longer than 120 seconds; contact-sheet pages cover consecutive video windows no longer than 60 seconds.
- Contact sheets use the existing 4×4 1920×1080 format and 1 MiB image limit.
- Use catalog-derived asset IDs for storage; directories are `0700`, files are `0600`; never accept filesystem paths from MCP callers.
- The MCP returns only manifest/segment data and at most one requested saved image; the source media stays local.
- A failed generation never replaces the last ready manifest; preserve partial sources and old generations, and add no deletion/cleanup behavior.
- Record source hashes, artifact hashes, algorithm/renderer versions and effective parameters; do not describe acoustic activity as speech recognition or listening.

## Review Focus

1. URL aliases, unsupported hosts, credentials and non-HTTPS schemes must canonicalize or fail before downloading. **Test:** Task 3 URL matrix; Task 4 lookup rejects invalid URLs.
2. Audio-only and video-only assets must mark the absent modality unavailable without reporting false analysis success. **Test:** Task 2 modality fixtures.
3. Tampered manifests, artifact hashes, path traversal and revoked/changed assets must never return stale or arbitrary files. **Test:** Tasks 1 and 4 storage/MCP rejection cases.
4. A failed run or a changed algorithm must resume/recompute only valid artifact classes and preserve the previous ready pointer. **Test:** Tasks 1 and 2 generation-resume and invalidation tests.
5. A maximum-length asset must respect 120-second audio chunks and gapless 60-second contact-sheet pages without unbounded MCP image output. **Test:** Task 2 synthetic 121-second video/audio fixture; Task 4 one-sheet-at-a-time assertion.

---

### Task 1: Persistent manifest and artifact store

**Files:**
- Create: `src/media/preparation-store.ts`
- Modify: `src/media/catalog.ts`
- Test: `tests/media-preparation-store.test.ts`

**Interfaces:**
- `fingerprintArtifact(kind: 'audio_scan' | 'contact_sheet', sourceSha256: string, parameters: unknown, algorithmVersion: string): string`
- `MediaPreparationStore(catalogHome: string)` with `current(assetId)`, `begin(assetId, sourceUrl, sourceSha256)`, `recordArtifact(assetId, generationId, artifact, data)`, `setStatus(assetId, generationId, status, progress)`, `commitReady(assetId, generationId)`, and `readArtifact(assetId, generationId, artifactId)`.
- `MediaCatalog.findBySourceUrl(canonicalUrl: string): Asset | undefined` returns only active registered assets whose `sourceUrl` exactly matches the canonical URL.
- Manifest and artifact metadata conform to the schema and fields in the approved spec; current-ready and incomplete generations remain distinct.

- [ ] **Step 1: Write failing store tests.** Cover stable fingerprints; private directory/file modes; atomic ready pointer; resumable partial generation; corrupted manifest/artifact hash rejection; traversal and malformed asset ID rejection.
- [ ] **Step 2: Run the tests and confirm they fail** because the store and URL lookup methods do not exist.

Run: `bun test tests/media-preparation-store.test.ts --timeout 30000`

Expected: FAIL on missing store exports/methods.

- [ ] **Step 3: Implement the store and source lookup.** Use generated UUID generation IDs, asset-ID-derived directories, exclusive temporary files and atomic rename. Validate manifests and hashes before returning bytes; never expose resolved disk paths.
- [ ] **Step 4: Run the store tests and confirm they pass.**

Run: `bun test tests/media-preparation-store.test.ts --timeout 30000`

Expected: all tests PASS; a failed `commitReady` leaves the previous `current.json` unchanged.

- [ ] **Step 5: Commit** the store and tests.

### Task 2: Preparation pipeline and resumable artifact generation

**Files:**
- Create: `src/media/preparation.ts`
- Modify: `src/media/preparation-store.ts`
- Test: `tests/media-preparation.test.ts`

**Interfaces:**
- `prepareMedia(catalog: MediaCatalog, asset: Asset, store: MediaPreparationStore, options?: { onProgress?: (phase: string, completed?: number, total?: number) => void }): Promise<PreparationManifest>`.
- The orchestrator verifies source bytes with `catalog.snapshot`, probes stream metadata, computes per-artifact fingerprints, runs `audioScan` with 120-second chunks, and calls `contactSheet` for consecutive windows of at most 60 seconds.
- Persist full audio scan JSON and each page JPEG; return a ready manifest only after all available modalities are verified. If a modality is absent, record it as unavailable.

- [ ] **Step 1: Write failing pipeline tests.** Assert full timeline coverage, audio chunk boundaries, absolute timestamps, no work on an unchanged ready preparation, selective regeneration after a fingerprint change, partial retry reuse, and modality-unavailable status.
- [ ] **Step 2: Run the tests and confirm they fail** because `prepareMedia` is missing.

Run: `bun test tests/media-preparation.test.ts --timeout 30000`

Expected: FAIL on missing orchestrator.

- [ ] **Step 3: Implement `prepareMedia`.** Inject the store and optional progress callback; reuse verified artifacts by fingerprint, checkpoint each completed page, and atomically publish only a complete generation.
- [ ] **Step 4: Run the pipeline tests and confirm they pass.** Include a low-resolution 121-second audio/video fixture that yields two audio chunks and three gapless contact-sheet pages; verify every page is <=60 seconds.

Run: `bun test tests/media-preparation.test.ts --timeout 30000`

Expected: all tests PASS; retry reuses completed verified outputs and does not change an earlier ready generation on failure.

- [ ] **Step 5: Commit** the pipeline and tests.

### Task 3: Idempotent `isymcp media prepare <url>` CLI

**Files:**
- Modify: `src/media/cli.ts`
- Modify: `src/media/catalog.ts` only if Task 1's lookup signature needs CLI-facing adaptation.
- Test: `tests/media-prepare-cli.test.ts`

**Interfaces:**
- Extend `mediaCommand(command: string | undefined, args: string[])` with `prepare` accepting exactly one URL.
- Reuse `youtubeSource`, `MediaCatalog.findBySourceUrl`, `MediaImporter.start/status`, and `prepareMedia`; an existing matching asset bypasses the downloader.
- Print phase progress to stderr and one compact JSON summary to stdout containing asset ID, status, duration, sheet count and segment count.

- [ ] **Step 1: Write failing CLI tests.** Cover canonical URL reuse, no second download/analysis on a ready matching fingerprint, new URL import through an injected fake downloader, failed import, invalid URL and wrong argument count.
- [ ] **Step 2: Run the tests and confirm they fail** because `prepare` is not a supported media command.

Run: `bun test tests/media-prepare-cli.test.ts --timeout 30000`

Expected: FAIL with the current usage error.

- [ ] **Step 3: Implement the prepare command.** Poll import status until complete/failed, reuse the returned or existing asset, invoke `prepareMedia`, and keep output free of local paths and provider diagnostics.
- [ ] **Step 4: Run the CLI tests and confirm they pass.**

Run: `bun test tests/media-prepare-cli.test.ts --timeout 30000`

Expected: all tests PASS; repeated prepare on a ready asset does not invoke downloader or processors.

- [ ] **Step 5: Commit** the CLI and tests.

### Task 4: Read-only `media_lookup` and cached contact-sheet retrieval

**Files:**
- Modify: `src/media/register.ts`
- Modify: `src/media/service.ts`
- Modify: `src/media/preparation-store.ts` only for a small read interface if required.
- Test: `tests/media-mcp.test.ts`

**Interfaces:**
- Register `media_lookup` with schema `{ url: z.string().url().max(2048), sheet_index?: z.number().int().min(0) }` and read-only annotations.
- `media_lookup` result is `not_found`, `not_prepared` or `ready`; ready includes source identity/hash, stream metadata, full stored audio-scan result, sheet index/time ranges and optionally one verified image selected by `sheet_index`.
- Lookup canonicalizes through `youtubeSource`, resolves an active catalog asset, verifies the registered source and manifest, and never starts import or preparation.

- [ ] **Step 1: Write failing MCP tests.** Cover unknown URL, registered-but-unprepared, ready lookup, source-hash mismatch, revoked asset, invalid sheet index, cached single-image retrieval, and absence of local path strings.
- [ ] **Step 2: Run the tests and confirm they fail** because `media_lookup` is not registered.

Run: `bun test tests/media-mcp.test.ts --timeout 30000`

Expected: FAIL because `listTools()` lacks `media_lookup`.

- [ ] **Step 3: Implement the shared service and tool registration.** Return stored JSON and at most the requested contact-sheet image; preserve token-free media behavior.
- [ ] **Step 4: Run MCP tests and confirm they pass.**

Run: `bun test tests/media-mcp.test.ts --timeout 30000`

Expected: all tests PASS; lookup never calls downloader, `audioScan` or `contactSheet`.

- [ ] **Step 5: Commit** the MCP lookup and tests.

### Task 5: Agent guidance, docs, unified MCP coverage and final verification

**Files:**
- Modify: `src/mcp/identity.ts`
- Modify: `tests/media-unified.test.ts`
- Modify: `README.md`
- Modify: `GUIA.md`

- [ ] **Step 1: Add a failing unified-tool test** that asserts `media_lookup` is exposed by Codex ISyMCP and media guidance looks up a supplied URL before importing.
- [ ] **Step 2: Run the test and confirm it fails** on the missing tool/instructions.

Run: `bun test tests/media-unified.test.ts --timeout 30000`

Expected: FAIL because the unified MCP inventory lacks the lookup tool.

- [ ] **Step 3: Update the shared Codex instructions and user docs.** Explain prepare/reuse/lookup, statuses, one-sheet retrieval, resumability, limits and that audio analysis is not transcription/listening.
- [ ] **Step 4: Run the focused integration tests.**

Run: `bun test tests/media-preparation-store.test.ts tests/media-preparation.test.ts tests/media-prepare-cli.test.ts tests/media-mcp.test.ts tests/media-unified.test.ts --timeout 30000`

Expected: all new and changed tests PASS.

- [ ] **Step 5: Run the full suite and inspect the final diff.**

Run: `ISYMCP_VIDEO_VISION_ENTRY=/home/danny/Development/video-vision-runtime/dist/index.js ISYMCP_VIDEO_VISION_NODE=/home/danny/.local/bin/node bun test --timeout 30000`

Expected: all tests PASS, `git diff --check` clean, no modified or deleted unrelated files.

- [ ] **Step 6: Commit** the instruction, documentation and integration-test changes; push the implementation branch and open a PR to `main`.

## Plan self-review

- **Spec coverage:** CLI import/reuse, preparation, metadata, audio segmentation, complete contact-sheet coverage, persistent versioned manifests, fingerprints, retries, lookup statuses, one-sheet retrieval, privacy, URL validation, media tampering, and docs all map to Tasks 1–5.
- **Step granularity:** Each task uses a failing test, observed red result, implementation, green verification and a focused commit.
- **Interface consistency:** Task 2 consumes Task 1's store/catalog interfaces; Task 3 consumes Tasks 1–2; Task 4 consumes Tasks 1–2; Task 5 documents and verifies the completed tool catalog.
- **Review focus coverage:** URL policy (Tasks 3–4), missing streams (Task 2), tampering/path safety (Tasks 1 and 4), invalidation/retry (Tasks 1–2), and maximum chunk/page bounds (Task 2 plus Task 4 output bound) have explicit tests.
- **Proportion:** Five independently reviewable tasks cover one integrated feature; no broad refactor or unrelated cleanup is planned.
