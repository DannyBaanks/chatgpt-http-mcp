# Local media execution ledger

2026-10-09, codex/local-media, in-place branch. No deletes, moves or original media writes.

Task 1: catalog, CLI, explicit IDs, changed/revoked/symlink rejection. Initial missing-module RED then GREEN. Task 2: synthetic silence/tone/pulse, real PNGs, process timeout/output limits; initial ffmpeg image encoder error resolved with audio output disabled. Task 3: provider, independent stdio entry point, concurrency, revocation midwork; real stdio audio and installed provider frame succeeded. Task 4: operator guide, README, notices, raw evidence, full suite and dedicated tunnel deployment.

Ruling: keep work on an isolated named branch in the existing checkout — avoids an additional worktree and leaves the installed absolute path usable — cost if wrong: checkout shares unrelated local edits; path-specific commit and status review required.
Ruling: use installed Video Vision through MCP; implement audio directly with FFmpeg — audio-analysis-mcp license absent — cost if wrong: additional maintained audio code instead of upstream reuse.
Ruling: retain plan/evidence files and use a single implementation commit — deletion budget zero and catalog/worker deadline dependencies were developed together — cost if wrong: less granular commit history.

Fresh-context review: audio image filters consumed suffix beyond end_seconds (P1); no shared deadline (P2); provider stdout bound should be explicit before parsing (P2). Fixed image input duration with silent-prefix RED→GREEN. Added AsyncLocalStorage shared deadline, abortable subprocesses/provider and bounded snapshot read checks; regression verifies elapsed total. SDK already has a 10 MiB default ReadBuffer ceiling; now explicitly 2 MiB with pre-parse rejection test. Deadline/buffer regression tests added after their fixes, not independently observed RED. Final full suite after explicit missing-provider test: 290 tests pass, zero fail, raw log preserved.

Live registration: video and extracted audio from the user's Angel Engine sample. MCP smoke returned one frame and two audio images. Native Tunnel MCP connect updated only alias video-vision; health and ready 200, process running. Control-plane polling state unknown from native status, remote ChatGPT call NOT_DEMONSTRATED. User must refresh the tool schema and query the provided IDs.

No deferred minor findings. No merge or push performed.
