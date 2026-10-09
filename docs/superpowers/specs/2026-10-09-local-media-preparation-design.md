# Local media preparation and URL lookup

**Status:** in-chat design approved on 2026-10-09; awaiting review of this written specification. No implementation is authorized until this document is approved.

## Goal

Let Danny prepare a public video once on his computer, then let ChatGPT retrieve the prepared evidence by its source URL. The computer performs downloading and analysis; the MCP returns only registered-asset metadata, analysis results and explicitly requested images. The existing media catalog remains the source of asset identity, source URL and SHA-256.

Success means that running `isymcp media prepare <url>` creates a durable, reproducible preparation, and a later `media_lookup(url)` finds it without downloading or recomputing valid artifacts. If no prepared result exists, lookup reports that state clearly and leaves the existing `media_import` workflow available.

## Existing components to reuse

- `MediaCatalog` registers explicit local files and YouTube imports with `asset_id`, canonical `sourceUrl`, byte count and SHA-256. Its `snapshot` method verifies the registered bytes before processing.
- `MediaImporter` validates public YouTube URLs, downloads without browser cookies, enforces the existing 500 MiB / 30-minute limits, and registers the completed file.
- `probe`, `audioScan` and `contactSheet` provide the local metadata, full-track acoustic segmentation and sampled video overview. `audioScan` is the implementation proposed in PR #25; this design assumes it is available.
- The current media tools are registered through `src/media/register.ts` for both standalone stdio and Codex ISyMCP. They do not require a Codex turn token.

## User flows

### Prepare from the CLI

`isymcp media prepare <youtube-url>` validates and canonicalizes the URL using the existing YouTube URL policy. It reuses a registered asset with the same canonical `sourceUrl`; otherwise it uses the existing downloader and importer limits to create one. It then verifies the asset through the catalog snapshot and prepares:

1. `media_info`-equivalent metadata and source identity (URL, asset ID, byte count and SHA-256).
2. A complete `audio_scan` with chunks no longer than 120 seconds, including effective RMS parameters and algorithm version.
3. A sequence of 4×4 contact sheets covering consecutive video windows of at most 60 seconds each. The final sheet may cover a shorter tail. Each sheet retains the existing 1920×1080 layout and 1 MiB response-image limit.

The command reports progress and finishes with a compact JSON summary containing the asset ID, manifest status, duration, sheet count and audio segment count. Repeating the command for an unchanged asset with matching pipeline versions reuses the ready preparation. It must not download a duplicate or regenerate current artifacts.

Preparation is synchronous from the CLI and prints progress for import, audio scan and each contact-sheet page. Existing importer restrictions remain in force; the longest analysis phase follows the `audio_scan` deadline. A failed or interrupted preparation is never presented as ready. A later invocation can retry from the registered asset without downloading it again and reuse fully verified artifacts from the incomplete generation. Existing source files and partial records are preserved.

### Retrieve from the MCP

Add read-only `media_lookup(url, sheet_index?)` to the shared media tool catalog:

- The required URL must pass the same public YouTube canonicalization checks as import.
- Without `sheet_index`, return JSON only: `found`, status (`not_found`, `not_prepared` or `ready`), asset identity, source hash, media metadata, manifest/pipeline versions, effective audio parameters, audio activity results with absolute timestamps, and the contact-sheet index with time ranges.
- If the asset is registered but has no current preparation, return `found: true`, `status: not_prepared` and its asset ID. Do not silently download, prepare, or expose its file path.
- With a valid `sheet_index`, return the same compact manifest summary and that single stored contact-sheet image. Reject an out-of-range index. This lets the model inspect cached visual evidence without transferring every sheet at once.
- A missing URL returns `found: false`; a revoked, changed or invalid asset never returns stale prepared results.

ChatGPT should call `media_lookup` before starting a new import for a user-provided YouTube URL. For `ready`, it should analyze the returned manifest and request only relevant sheet pages; for `not_prepared` or `not_found`, it should follow the existing `media_import` flow or ask the user to run the local prepare command. Existing `video_frame`, `audio_analyze` and contact-sheet tools remain available for focused follow-up analysis.

## Persistent manifest and artifacts

Store preparation data beneath the media catalog, in a directory derived only from the validated asset ID, for example:

```text
<catalog>/preparations/<asset_id>/generations/<generation_id>/
  manifest.json
  audio-scan.json
  contact-sheet-000.jpg
  contact-sheet-001.jpg
  ...
<catalog>/preparations/<asset_id>/current.json
```

The catalog and generated artifacts remain private to the local user (directory mode `0700`, files `0600`). MCP responses expose neither filesystem paths nor arbitrary path inputs. Write each artifact to a generation-specific directory and atomically record its verified fingerprint and completion in that generation's manifest. The manifest may be `preparing`, `partial`, `failed` or `ready`; it records the last completed phase and page. Atomically update `current.json` only after every available modality has been processed and the manifest is complete. A failed generation must not replace a previous ready generation. A retry resumes a matching incomplete generation after revalidating its source and completed artifact hashes. Preserve old generations; this feature does not add artifact deletion or cleanup.

The manifest uses schema version `isymcp-media-preparation/1` and records:

- canonical source URL, asset ID, SHA-256, size, preparation timestamp, duration and stream metadata;
- status and generation ID;
- each artifact's kind, relative generated filename, byte count, hash and time range;
- audio algorithm version, chunk size and effective segment parameters;
- contact-sheet format/layout version, page windows and requested sample timestamps;
- tool/pipeline version identifiers used for cache validation.

Relative filenames are resolved only beneath the generation directory after validating the manifest and generated-file hashes. Never accept a path or filename from the MCP caller.

## Cache validity and regeneration

Use an artifact-specific fingerprint derived from the source SHA-256, relevant parameters and algorithm/renderer version. If the source hash is unchanged, reuse artifacts whose fingerprints still match. When only audio segmentation changes, rerun `audio_scan` while retaining valid contact sheets; when only the contact-sheet renderer or parameters change, regenerate sheets while retaining the audio result. If source bytes differ from the catalog record, fail with the existing “asset changed; register again” behavior and return no preparation.

The preparation manifest stores effective parameters rather than relying on defaults, so an older run remains reproducible and any future default change is detectable.

## Failure behavior

- Invalid or unsupported URL: reject before downloading.
- Import/download failure: report the existing generic import error; do not claim preparation succeeded.
- No audio or no video stream: record the available stream metadata and mark the missing modality explicitly; generate only artifacts supported by the source. A source with neither supported stream is rejected by the existing importer.
- FFmpeg or contact-sheet error: keep the previous ready generation, mark the new run partial/failed with the failing phase, and return a safe error without leaking local paths or subprocess diagnostics. A retry can resume verified completed pages and audio output.
- Disk or manifest write error: do not move `current.json`; a later retry may reuse only fully verified artifacts.
- Lookup with unknown, revoked or tampered media: return a non-ready result or existing catalog error, never stale artifact contents.

## Security and privacy

Use the existing importer URL allowlist, size and duration limits, catalog verification and private local storage. `media_lookup` accepts only a source URL, never an asset path. An asset is visible only if explicitly registered by import or local registration. Source video and audio stay on the user's computer; only the requested manifest/segment data and at most one requested contact-sheet image are returned to the MCP client. No browser cookies, arbitrary filesystem access, transcription or native-audio claim is introduced.

## Out of scope for version 1

- Extracting every video frame or preparing every frame at source FPS.
- Range-specific `media_prepare_range(..., frames="all")` and individual-frame artifact caching.
- ASR/transcription, speaker diarization, sound-source separation or claims that GPT natively heard the original audio.
- Replacing Video Vision with an FFmpeg fallback for `video_frame`.
- Automatically starting expensive preparation from `media_lookup`.
- Deleting originals, partial downloads, old generations or revoked assets.

## Acceptance criteria

1. A valid public YouTube URL can be prepared via CLI; the resulting asset remains registered with its source URL and SHA-256.
2. Preparation produces metadata, full-track audio results when an audio stream exists, and ordered contact-sheet pages that cover the complete video window without gaps, with every page at most 60 seconds. Missing audio or video is explicitly recorded as unavailable rather than treated as a successful analysis of that modality.
3. A second prepare with the same source hash and pipeline fingerprint reuses the preparation and performs no download or analysis work.
4. Changing one algorithm fingerprint regenerates only that modality's artifacts and records the new effective parameters/version.
5. `media_lookup` is advertised by both MCP entry points, resolves the canonical source URL, returns complete stored audio results and manifest status, and can return one verified sheet image by index without exposing a path.
6. Not-found and registered-but-not-prepared states are distinguishable; lookup never starts a download or expensive computation.
7. Revoked, changed, malformed or tampered assets/manifests cannot yield stale or arbitrary local files.
8. Failure during a new generation does not replace a previous ready manifest; retries can reuse the registered source and verified artifacts from the interrupted generation.
9. Tests cover CLI preparation, source reuse, manifest atomicity/version invalidation, MCP lookup states, single-sheet retrieval, URL/path abuse, stream absence, and a video/audio fixture crossing a 60-second video page and 120-second audio chunk boundary.

## Implementation sequence after spec approval

1. Add manifest/artifact storage and pure validation/fingerprint helpers with tests.
2. Implement idempotent `media prepare <url>` on top of the importer, catalog snapshot, `audioScan` and contact sheets.
3. Add read-only `media_lookup` and one-sheet retrieval through the shared media registration/service layer; update the Codex instructions to look up a URL before downloading.
4. Update README/GUIA, run the media tests and full suite, then push an implementation branch and open a PR.

## Review notes

- The specification treats contact sheets as one 4×4 page per consecutive ≤60-second window. This provides full timeline coverage without caching all frames; the storage and processing costs increase with video duration, up to 30 pages for the importer’s 30-minute maximum.
- The manifest summary returns full audio segment data because the goal is to let ChatGPT inspect precomputed results. The MCP retrieves contact-sheet images one page at a time to keep responses bounded.
- This is a design proposal. No behavior, implementation, performance or end-to-end result described here is currently demonstrated by the repository.
