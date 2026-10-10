# Guided YouTube preparation from the CLI

## Goal

Make local YouTube preparation easy to start from the terminal without requiring the user to remember a command syntax. The user should paste one public YouTube URL, choose an output folder with an OS folder dialog, review basic video metadata, and explicitly confirm before any download begins. A successful run leaves a portable package in the chosen folder and keeps the verified private catalog entry used by `media_lookup`.

The supported host for the first release is the current Linux desktop environment. This keeps the first implementation testable on Ubuntu and avoids adding GUI frameworks or platform-specific dependencies for operating systems that are not currently exercised.

## Existing behavior and evidence

- `isymcp media prepare <url>` currently imports or reuses the source, creates a complete audio scan and contact sheets, and stores them under the private media catalog. It does not prompt for a URL or destination and does not export a package.
- The interactive menu is driven by `src/menu.ts` and `src/isymcp.ts`; `tests/menu.test.ts` verifies that every visible leaf has an action.
- The existing full Bun suite passed 320 tests with one skip. `bun src/isymcp.ts smoke` passed its five checks. Read-only/dry-run CLI checks and TUI arrow-key navigation also passed during this task.
- Existing tests do not execute every documented CLI command as a process, and the current smoke suite does not cover every menu leaf or media preparation UX.

## Considered approaches

1. **Add more required flags** such as `--url` and `--output`. This is script-friendly but keeps the user in command syntax and does not provide the requested native folder dialog.
2. **Build a separate desktop application.** This gives full control of the flow but adds a GUI runtime and duplicates the existing CLI and preparation pipeline.
3. **Extend the existing media CLI and menu (recommended).** Keep the current non-interactive `media prepare <url>` path, add a guided mode when `media prepare` has no URL, and expose the same guided action in the main TUI. Reuse the importer, catalog and preparation store.

## User flow

1. The user chooses **Preparar video de YouTube…** from the main menu, or runs `isymcp media prepare` without an argument.
2. The CLI prompts for a public YouTube video/Short URL. It accepts pasted URLs and applies the existing HTTPS/host/individual-video validation and canonicalization.
3. The CLI opens an OS-native directory chooser. On Linux, use an installed `zenity` or `kdialog` executable; do not install either automatically. If neither is available, report a clear dependency message and stop. Canceling the chooser stops the flow without contacting the downloader.
4. The CLI requests metadata without downloading media, using the same configured yt-dlp executable and no cookies, plugins, config files or cache. It displays the canonical URL, title, channel/uploader, duration, available resolution and estimated size when yt-dlp provides them. Missing optional metadata is shown as unavailable rather than guessed.
5. The user confirms or cancels. Cancellation starts no download and creates no package.
6. On confirmation, the CLI downloads under existing source policy and limits, validates/registers the media, then runs the existing preparation pipeline. Progress goes to stderr; the user sees a final summary on success.
7. After private preparation is verified as ready, the CLI exports a package inside the selected parent folder. The package contains the original media, a manifest with canonical URL, asset ID, source hash, media metadata, tool/algorithm versions and artifact hashes, the complete audio-scan JSON when audio exists, and ordered contact-sheet JPEGs when video exists.

## Package and storage behavior

- Keep the private media catalog as the source of truth so `media_list` and `media_lookup` continue to work. Exporting is an additional user-visible copy.
- Create a safe, human-readable child directory using the video title and stable YouTube ID. Sanitize path separators, control characters and platform-reserved names; do not trust metadata as a path.
- Never replace an existing package. If the chosen package name already exists, ask to choose another parent or cancel; do not append into an existing folder.
- Write the export to a uniquely named partial directory under the selected parent, verify all copied hashes against the catalog manifest, then rename it to the final package directory. A failed export leaves the verified catalog intact and reports the partial export path without claiming that the package is complete.
- Cancellation before confirmation performs no download. A download or analysis failure preserves the existing importer/preparation recovery behavior and never advertises an incomplete export as ready.
- Do not add arbitrary-path access to MCP tools. The directory is chosen locally by the user through the OS picker.

## CLI and menu interface

- Add a menu leaf under **USAR** for the guided flow, with a visible label such as **Preparar video de YouTube…**.
- Add `isymcp media prepare` as the guided interactive form. Preserve `isymcp media prepare <url>` as the existing scriptable, non-interactive behavior and JSON output contract.
- Document both forms in `help()` and `GUIA.md`. The guide must be updated only after its commands are executed and its sample output is captured.
- Keep URL validation, download policy, private registration, complete analysis and export as separate testable operations. Do not create a second analysis pipeline.

## End-to-end verification

Add a CLI E2E matrix that launches the CLI in a temporary home/config and uses controlled ports, fake bridge/tunnel/downloader/dialog executables, and generated media fixtures. Exercise every visible menu leaf and documented command path at the process boundary. Operations that normally mutate a user's host must be tested against temporary configs or stub executables, including cancel paths and dry-runs; the test suite must never alter the real Codex config, live tunnel, real harness configs, user sessions or real log exports.

The guided media E2E test must cover:

- URL paste, valid canonicalization and rejection of unsupported URLs.
- Folder picker success and cancellation; no download on cancellation.
- Metadata preview fields, missing metadata and explicit confirmation/cancellation.
- Download, registration, preparation, full package export, and hash verification with a generated media fixture.
- Existing package collision, safe title sanitization and export failure behavior.
- The current one-argument `media prepare <url>` contract remains non-interactive and retains its compact JSON result.
- Menu leaf registration has a matching action and renders/navigates correctly in a TTY.

Also run the existing full test suite, `isymcp smoke`, and focused media/menu tests. Live canary turns, live account-model changes, tunnel stop/connect, and session revocation stay outside automatic E2E tests; validate their CLI parsing and safe cancel/dry-run paths with isolated fakes instead.

## Acceptance criteria

1. A user can start the guided flow from the main menu or by running `isymcp media prepare` with no arguments.
2. Before downloading, the user has selected an output folder and reviewed real preliminary metadata and confirmed.
3. Canceling URL input, the native picker or confirmation does not start a download.
4. A completed run produces the original media and a complete, hash-verified analysis package in the selected folder, while the catalog remains discoverable by ChatGPT.
5. Existing `isymcp media prepare <url>` callers keep working.
6. The isolated CLI E2E matrix covers the documented commands and visible menu leaves without mutating the user's real environment; the existing suite and smoke checks pass.

## Not included

- Native pickers for macOS or Windows in this first release.
- Automatic installation of `zenity`, `kdialog`, yt-dlp, FFmpeg or Video Vision.
- Playlists, livestreams, authenticated downloads, transcription, speech recognition or source separation.
- Uploading the source video/audio to ChatGPT. Only requested analysis outputs continue to be returned through MCP.
