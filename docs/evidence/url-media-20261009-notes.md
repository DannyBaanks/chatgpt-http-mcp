# URL media import evidence

User authorized completing the URL -> local download -> registration -> local audio/video analysis flow in the existing Codex ISyMCP. Implemented initial YouTube/Shorts support, with a background job and short status calls instead of one streaming request held throughout download.

Source: Video Vision's downloader uses yt-dlp and bounded resolution. Integrated yt-dlp directly as a CLI dependency with isolated HOME/config/plugins/cookies behavior, while retaining the installed Video Vision MCP provider for actual frames. No unlicensed Audio Analysis source copied; no automatic software update or cookie access. Official reference: https://github.com/yt-dlp/yt-dlp#usage-and-options . Existing yt-dlp binary reported 2026.08.19.

RED→GREEN: importer module initially missing; tests now verify canonical individual YouTube URLs, rejection of arbitrary/private destinations, one import, asynchronous state, registered real tone fixture, failed/nonmedia/oversized refusal, disk guard and timeout. Additional RED→GREEN: grouped download survived parent SIGTERM before fix; now the test confirms child terminated. Existing native tools and token requirements remain covered.

Real network smoke used the user's exact https://www.youtube.com/shorts/lHkDE3BahB0 through MCP main.ts. Fresh download succeeded with audio and video; no existing cached asset was passed to the importer. Registered file: 989440 bytes; SHA-256 af5d0a6c35ee5b9141e5f9620c9eb79fe38d7791543022b8f4c281df745739af. Local protocol returned audio waveform/spectrogram and a real Video Vision frame. Raw output/stderr and test logs are preserved beside this file. No original source or user media files were deleted. Failed-job partial artifacts remain local.

Limits: 500 MiB final file, <=720p requested, 30-minute source, 180-second import/validation, 60-second analysis, worker shared within each server instance. Disk monitor kills a grouped downloader if a file exceeds 500 MiB, aggregate workspace exceeds 1 GiB, or disk free space drops below 64 MiB. Polling job status and catalog listing remain available during work. Recent job state is in memory (50 entries); local journal retained; server restart does not resume downloads, registered assets persist.

NOT_DEMONSTRATED: remote ChatGPT invocation/schema refresh for the new import tools. Earlier manifests are historical source states and are not rewritten for changed source hashes. Current source hashes recorded in a new manifest.
