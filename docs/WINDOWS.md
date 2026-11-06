# ISyMCP on Windows

ISyMCP's CLI, HTTP bridge, panel, browser integration, session storage, and
tunnel client can run on a Windows host. Sandboxed commands can run as native
PowerShell in Codex's Microsoft Execution Containers (MXC) sandbox or inside
the Docker Desktop Linux fallback. Native enforcement uses Codex CLI permission
profiles and Windows process isolation.

## Requirements

- Windows 10/11 x64.
- Bun 1.4.2 or newer.
- Codex CLI 0.162.0 or newer and an MXC-capable Windows 11 build for native
  PowerShell execution. MXC is available on Windows 11 24H2 build 26100.9278
  and 25H2 build 26200.9278 or newer; other devices can use Docker Desktop's
  Linux engine.
- Google Chrome or Microsoft Edge for browser-backed features.
- FFmpeg and FFprobe on `PATH` for media analysis.
- Node.js 24 LTS for the optional video-frame provider.
- yt-dlp for public video imports.
- The pinned `tunnel-client` Windows asset is downloaded and verified by the
  installer when the ChatGPT MCP tunnel is enabled.

### Install missing tools

Git, Bun, Docker Desktop, FFmpeg, Node.js, and yt-dlp can be installed from
the WinGet source:

```powershell
winget install --id Git.Git --exact --source winget
winget install --id Oven-sh.Bun --exact --source winget
winget install --id Docker.DockerDesktop --exact --source winget
winget install --id Gyan.FFmpeg --exact --source winget
winget install --id OpenJS.NodeJS.LTS --exact --source winget
winget install --id yt-dlp.yt-dlp --exact --source winget --skip-dependencies
```

Skip tools already present. The Gyan FFmpeg package is a third-party Windows
build linked from FFmpeg's download page; it supplies `ffmpeg.exe` and
`ffprobe.exe` and is GPL-3.0. Close and reopen PowerShell (and restart Codex if
it was already open) after installation so the updated user `PATH` is loaded.
Install Codex CLI for the native Windows sandbox:

```powershell
npm install --global @openai/codex
codex --version
```

Use Docker Desktop only when you want Linux commands on the Windows host or
when the native Codex sandbox is unavailable. Then confirm the tools you plan
to use:

```powershell
bun --version
git --version
node --version
npm --version
docker info --format '{{.OSType}}'
ffmpeg -version
ffprobe -version
yt-dlp --version
```

## Install and start

Run these commands from PowerShell:

```powershell
git clone https://github.com/DannyBaanks/chatgpt-http-mcp.git
Set-Location chatgpt-http-mcp
bun install --frozen-lockfile
bun link
isymcp server start
isymcp panel
```

Native Windows mode:

```powershell
[Environment]::SetEnvironmentVariable('CODEX_WEB_HTTP_WINDOWS_SANDBOX_BACKEND', 'native', 'User')
$env:CODEX_WEB_HTTP_WINDOWS_SANDBOX_BACKEND = 'native'
isymcp server start
```

Restart the MCP server after changing the setting. Native mode explicitly uses
MXC and does not need the optional Windows Sandbox feature or administrator
provisioning. If the device does not support MXC, native execution fails closed;
select the Docker backend instead. See [Codex Windows sandbox requirements](https://learn.chatgpt.com/docs/windows/windows-sandbox)
and the [permission profile guide](https://learn.chatgpt.com/docs/permissions).

The MXC profile requires `:root` read access so Codex can resolve workspaces on
any drive. It denies the current user's profile and known credential paths,
then reopens only the selected workspace, private scratch directory, and
executable search paths. Other host paths are read-only. Writes stay inside the
selected workspace, and network access is disabled by default. Choose Docker
when a task needs read isolation from other host paths as well.

Run the native MCP E2E check on an MXC-capable host with Codex CLI installed:

```powershell
$env:ISYMCP_WINDOWS_NATIVE_E2E = '1'
bun test tests/windows-native-e2e.test.ts tests/windows-sandbox.test.ts
```

The network check first confirms the host can connect to `1.1.1.1:443`; if that
control is unavailable, it skips only the outbound-network assertion.

The Docker fallback is selected with
`$env:CODEX_WEB_HTTP_WINDOWS_SANDBOX_BACKEND = 'docker'`; build its image with
`bun run sandbox:build`. That backend runs Linux commands in a container with a
read-only root, network disabled by default, dropped capabilities, resource
limits, and only the selected workspace mounted. A writable session grants
writes to that workspace alone. Network access is opt-in through
`CODEX_WEB_HTTP_SANDBOX_NET=1` in either backend.

Create a scoped session and then connect the tunnel if needed:

```powershell
isymcp session mint --cwd C:\work\my-project --write
isymcp tunnel connect
isymcp status
```

To configure the first connection, run the interactive setup. It opens your
browser at the OpenAI organization settings page, then asks for the tunnel ID
and runtime API key. Paste each value and press Enter; both fields are hidden.
The command validates the values, installs the pinned client if needed, stores
the ID and key separately under ISyMCP's ACL-protected home, starts the bridge
if it is down, and connects the tunnel:

```powershell
isymcp tunnel setup
isymcp status
```

The runtime key is never placed in command arguments, terminal echo, or logs.
On Windows, the credential directory and files receive private NTFS ACLs.

Use `isymcp tunnel stop` and `isymcp server stop` to stop services. Session
registries and visible-browser credentials are protected with Windows ACLs;
local IPC uses per-user named pipes. The browser launcher detects Chrome or
Edge in the usual per-user and Program Files locations. Override it with
`CHROME_PATH` or `CODEX_WEB_HTTP_CHROME` when the browser is installed elsewhere.

The isolated Codex Desktop App launcher is disabled on every platform while
multi-profile authentication remains `UNKNOWN / NO EXECUTE` in the account
safety policy. It copies the signed-in account's `auth.json`; use
`isymcp conversation new --client cli` instead.

`isymcp canary schedule --apply` creates a daily 09:00 Task Scheduler task for
the current user. It runs only while that user is signed in, because the canary
uses the user's browser session.

## Optional local video-frame provider

`video_frame` uses the separate MIT-licensed [Video Vision
provider](https://github.com/OAMaestro/video-vision-mcp). On 2026-10-15 its npm
package returned 404, so this Windows setup builds the verified source commit
directly. Install Node.js 24 LTS first:

```powershell
$providerRoot = Join-Path $env:LOCALAPPDATA 'ISyMCP\video-vision-provider\source'
git clone --depth 1 https://github.com/OAMaestro/video-vision-mcp.git $providerRoot
git -C $providerRoot checkout cb854278518c46943a5b9e89643f2e29c7aca839
Set-Location $providerRoot
npm ci --no-audit --no-fund
npm approve-scripts sharp onnxruntime-node protobufjs
npm rebuild
npm run build

$node = (Get-Command node.exe).Source
[Environment]::SetEnvironmentVariable('ISYMCP_VIDEO_VISION_ENTRY', (Join-Path $providerRoot 'dist\index.js'), 'User')
[Environment]::SetEnvironmentVariable('ISYMCP_VIDEO_VISION_NODE', $node, 'User')
[Environment]::SetEnvironmentVariable('ISYMCP_YTDLP_BIN', (Get-Command yt-dlp.exe).Source, 'User')
```

`npm approve-scripts` records approvals for the reviewed dependency install
hooks on npm 11. Restart PowerShell and Codex after setting the variables so
the MCP process receives them. Audio analysis and FFmpeg contact sheets do not
require Video Vision; frame extraction does.

## Platform boundary

The Windows host owns the UI, HTTP listener, browser, and files. With the
default Docker backend, sandboxed `codex_exec` commands run in Linux; use Linux
tools and `/workspace` paths in that mode. With the opt-in native backend,
commands run in Codex's Windows sandbox and can use PowerShell and Win32 tools.
`codex_apply_patch` is sandboxed in either mode. ISyMCP does not silently fall
back to unsandboxed host execution when the selected sandbox is unavailable.

The media chooser is native on Windows, and media processing uses Windows
builds of `ffmpeg` and `ffprobe` on `PATH`. The experimental
ChatGPT.com browser path remains subject to the account and policy risks in
the main [README](../README.md#limitations--risks--read-before-using).

The isolated Codex Desktop App launcher is disabled on every platform by the
P0 authentication policy. Windows CLI, HTTP bridge, panel, MCP, browser,
tunnel, scheduled canary, and sandbox integration have Windows-specific code
and CI coverage, with live runtime status listed below.

## Current evidence on Windows

Verified 2026-10-15 on Windows 11 25H2, build 26200.9457, with Bun 1.4.2 and
Codex CLI 0.162.0-alpha.17.2. The command above completed with **7 pass, 0 fail**
(45 assertions). Its live MCP flow wrote and patched a CRLF file in the selected
workspace, denied reads from the current user's private paths, denied writes
outside the workspace and in a read-only session, and blocked an external TCP
connection after a successful host-side control. The Windows-host CI suite also
passes; the Linux CI suite exercises bubblewrap. Docker-backed execution on this
host remains **NOT_DEMONSTRATED** because its daemon storage is read-only.

Re-verified 2026-11-05 on this host: the sentence above no longer holds, and it is
kept as the historical record of that day's state rather than rewritten. Docker-backed
execution ran against the real image `isymcp-sandbox:1.0.0-rc.2` and passed the live
sandbox suites — `sandbox: aislamiento de secretos` (5), `TEST A`–`TEST D` of the
native tool surface, `MCP con session tokens` (6) and `M4: boundary de autoridad` (4).
Those tests now address the workspace with **relative** command arguments and check the
result through the host path, which is the contract in *Platform boundary* above: the
container sees `/workspace`, bubblewrap sees the same absolute path as the host, and
`codex_exec` arguments are never rewritten. A read-only session still cannot write
(`echo pwn > pwn.txt` exits non-zero against the `readonly` bind), and every DENY is
still verified by the absence of an observable mutation.

Also re-verified 2026-11-05: the Video Vision provider above now installs and
`video_frame` is **demonstrated** on this host rather than assumed. `npm view
video-vision-mcp version` still returns 404, so the source commit in the install block
remains the only route. This host runs Node 24.18.0 (module ABI 137, x64) and both
`node` on `PATH` and `ISYMCP_VIDEO_VISION_NODE` resolve to that one binary, so install
time and run time share an ABI. `npm ci` failed three times with `ECONNRESET` because
`onnxruntime-node@1.21.0` is a 217,912,684-byte tarball and npm does not retry a reset
that happens partway through the body — it only removes `node_modules` and aborts. The
workaround that completed the install was `npm ci --registry=https://registry.npmmirror.com`;
npm still validates every tarball against the `integrity` recorded in `package-lock.json`,
so the bytes stay pinned to the published ones. `approve-scripts`, `rebuild` and
`npm run build` then succeeded, `dist/index.js` came up in 950 ms exposing
`extract_frame_at`, and `bun test tests/media-video.test.ts` passes by returning a real
frame from a real FFmpeg fixture. One caveat measured on the provider's bundled
`ffmpeg.exe` (N-92722): it prints `Fontconfig error: Cannot load default config file`
because it is built with fontconfig but the host ships no default config, yet it still
writes the frame and exits 0. The host's own FFmpeg 9.0.2 takes the same filter string
and produces nothing at all, so a frame extracted through a different FFmpeg binary is
not equivalent evidence.

## Windows CI coverage

Updated 2026-11-05: the `windows-host` job no longer runs a hand-picked five files. It
now runs **everything under `tests/` except seven files that this runner cannot satisfy**,
so a new test file is covered on Windows by default instead of by memory.

Why those seven, and nothing else:

| Excluded | Missing capability | Measured consequence |
|---|---|---|
| `authority-boundary`, `mcp-native-tools`, `mcp-session`, `mcp-tool-call-retry`, `chat-phase2-tools` | a real sandbox backend | `sandboxBackend()` fails closed to `"none"`, `runExec` refuses, so the precondition `executed: true` is unreachable |
| `media-export` | `mv` on the Windows PATH | `src/media/export.ts:62` publishes with `mv -T -n --`; the spawn throws `ENOENT` |
| `exec-registry-retry` | `sleep` on the Windows PATH | the test spawns `sleep 60` unsandboxed, same `ENOENT` |

`tests/sandbox-isolation.test.ts`, `tests/windows-native-e2e.test.ts` and
`tests/codex-entry-isolation.test.ts` are **included** even though they need capabilities
too: they gate themselves (`describe.skipIf(!sandboxAvailable())`, the
`ISYMCP_WINDOWS_NATIVE_E2E=1` opt-in) and a reasoned skip in the CI log is information,
while an absent capability that is not probed is just a red run.

Runner facts taken from the image READMEs of `actions/runner-images` (Windows2022 and
Windows2025, `windows-latest` = Windows 2025): no `ffmpeg`/`ffprobe` anywhere in the image,
Docker present as the Moby **Windows-container** daemon (Docker Desktop is not installed and
the pre-pulled bases are `servercore`/`nanoserver`), Chrome/Edge with their drivers on PATH,
Node 22.x, Git, Python. GitHub-hosted Windows runners are 4 vCPU/16 GB on public repos and
2 vCPU/8 GB on private ones. Two consequences are handled in the job rather than in the
tests: FFmpeg is installed with `choco install ffmpeg` (bounded step, mirroring the Ubuntu
job's rule that the toolchain is provisioned, not simulated) and it is asserted to carry the
`drawtext` filter, because `src/media/contact-sheet.ts:27` builds contact sheets with it; a
build without that filter would otherwise fail tests for a reason that is not the product's.
`timeout-minutes` went 15 → 30 to leave room for the slower runner.

Evidence for the exclusion list, obtained on this host by **simulating** the runner
environment rather than by reading the code: every `Docker` and every `Git\usr\bin` entry
was removed from the process PATH (probe line `docker=NO mv=NO sleep=NO ffmpeg=SI`), then
each file was run alone — 78 of the 85 files exited 0 and the 7 above exited 1 — and finally the exact
CI command was run as one process:

```
500 pass / 15 skip / 0 fail
Ran 515 tests across 78 files. [139.73s]        exit 0
/tmp/ci-cmd.log  sha256 aecd37aa0b4ffa0667fb89921f6b4b1f40fe71cd862a40ce46fb1e68ffd09f6f
/tmp/ci-sim.log  sha256 f39beb1de2d0c166aaafe7cf9e917af211a697783f3f51d6095018c71b63c613
```

The two causes in the table were separated by a control run, because both are absent
together in the simulation: with Docker removed but `Git\usr\bin` kept,
`media-export` and `exec-registry-retry` pass 9/9 in 17.11 s. So those two fail over
coreutils alone, and the five sandbox files fail over the backend alone.

The 15 skips here against 10 on the full local suite are exactly the
`sandbox: aislamiento de secretos` cluster: with no backend available,
`describe.skipIf(!sandboxAvailable())` skips those five live tests. Nothing was deleted
from the assertions; the capability was removed and the suite said so out loud.

`NOT_DEMONSTRATED`: no GitHub Actions run of this widened job has been observed yet —
that requires a push, and the first real run is what will confirm two things the image
README cannot confirm from here: that the Chocolatey FFmpeg build behaves like the host's
for these tests, and that the runner's PATH really lacks `mv`/`sleep`. The exclusion list
above is a simulation of that environment, not a measurement of the runner itself.

Open defect surfaced by this work, recorded rather than worked around: the atomic
no-replace publisher in `src/media/export.ts:62` shells out to GNU `mv`, so on Windows
media-package publishing depends on coreutils being on `PATH` — which is true on this
workstation only because Git for Windows put `usr\bin` there, and is not a documented
requirement in *Requirements* above. A native no-replace rename would remove the
dependency and let both excluded files back into the job.

Updated 2026-11-06: `origin/main` was merged (140 commits, 16 conflicted files, 24 new
test files). Verified on this host afterwards: **704 pass / 17 skip / 0 fail**, 721 tests
across 109 files, 293.16 s.

```
bun test                                            exit 0
/tmp/isymcp-win-merge3.log  sha256 61f22c2b87c4e89fe7a6b5d4e4a58dac91c6169cd7281d38564630de0cebaf22
```

Against the 2026-11-05 pre-merge run (555 / 10 / 0, 565 tests, 85 files) no test name
disappeared and no passing test turned into a skip. Exactly three names left the list, and
upstream replaced each one in place: two `token del bridge` cases became
`sin variable: token propio 0600…` and `cualquier exposicion prepara el token…`, and
`codex_exec con token de turno deja tool.result con turn_id y sin stdout` became
`codex_tool_inventory conserva el ID de llamada hasta tool.result sin exponerlo en la
tarjeta` — the same assertion after the correlation moved from `turn_id` to `call_id`.

`bun run typecheck` (`tsc --noEmit`) is exit 0. The merge made it a blocking CI step, and
it immediately caught two type errors that had never been checked on this branch:
`tests/cli-e2e.test.ts` inferred a *closed* object type for `isolated().env`, so
reassigning it with `ISYMCP_TUNNEL_CLIENT_BIN` was rejected; and a `platform:'tiktok'`
literal widened to `string` against the receipt union in `tests/media-catalog.test.ts`.
Both are fixed as part of the merge, not after it.

Four things failed that were not conflict-resolution errors but consequences of what
upstream brought. Each is recorded with the measurement that identified it:

- `DEFAULT_WINDOWS_SANDBOX_IMAGE` moved from `isymcp-sandbox:1.0.0-rc.2` to `1.0.1`
  (`src/codex-sessions.ts:365`). This host had only rc.2, so `sandboxBackend()` failed
  closed to `"none"`, `runExec` refused and 18 sandbox tests could not run — the contract
  behaving exactly as designed, not breaking. Rebuilt with `bun run sandbox:build`
  (953 MB; rc.2 left in place rather than retagged); the six affected files then pass
  52/52 in 70.34 s.
- Tablero (`src/tablero/`) is new, and its default interpreter came from
  `Bun.which("python3")`. On this host that resolves to the Microsoft Store App Execution
  Alias: the file exists, so `config.ts` accepted it, and executing it exits 49 saying
  "Python was not found" — the trap the root contract names. Measured: `python3` exit 49,
  `…\Python312\python.exe` exit 0 (3.12.10), `…\Launcher\py.exe` exit 0. `detectPython()`
  now takes the first candidate that actually prints a version, and
  `tests/tablero.test.ts` uses it instead of `Bun.which("python3")!`. 9 failures, fixed.
- `tablero launch(dry_run: true)` threw `tablero_tmux_missing` although a dry run spawns
  nothing: `argv` was built before the early return and building it resolves tmux
  (`src/tablero/service.ts:273`). `argv` is now built after it. Nothing changes on a host
  that has tmux, so this is a general defect, not a Windows one — upstream CI always has
  tmux, which is why nobody saw it. 1 failure, fixed.
- `tests/bridge-token.test.ts` created a **file** symlink to prove `bridgeToken` refuses
  one. Windows needs SeCreateSymbolicLinkPrivilege (Developer Mode) for that and fails
  with EPERM before the guard is reached. A junction is no substitute — directories only —
  and a hard link is not a symlink, so `bridgeToken` would not refuse it and the
  assertion would lie. That half is now gated on POSIX, where it runs, with the reason
  written in the file. 1 failure, documented and gated.

`tests/sandbox-isolation.test.ts` needed a different treatment. Main's new
`/run del host queda tapado` asserts that `/run` is *empty*, which is the bwrap mechanism:
`HOST_MASKS = ["/run","/var/run","/var/log"]` puts a tmpfs over each. The Docker backend
never binds the host `/run` at all — its mount namespace knows only the workspace and
source-root binds — so the property holds by construction and what the listing shows is
the image's own `/run/lock`. Measured in both images:

```
MSYS_NO_PATHCONV=1 docker run --rm --entrypoint sh <image> -c 'ls -A /run; ls -A /var/run'
isymcp-sandbox:1.0.0-rc.2 -> lock   isymcp-sandbox:1.0.1 -> lock
```

The content did not change; the test is bwrap-specific and was not scoped, unlike the
socket test two lines below it, which upstream correctly marked
`skipIf(backend !== "bwrap")`. It now carries the same scope, so the assertion is not
weakened to fit a failure and the Docker backend is not given a tmpfs it does not need.

Skips went 10 → 17 and every added name is a capability or a stated design, none silent:
3 tablero tests gated on `hasTmux`, 2 bwrap-only sandbox tests, and 2 in main's new
`tests/launcher-shortcut.test.ts`, whose header comment already says the Windows job does
not execute that file because it drives the helper with POSIX `true`/`false`.

Also 2026-11-06, closing the `NOT_DEMONSTRATED` above: the widened job **has** now run on
a real GitHub-hosted Windows runner. The PR itself could not trigger it — a `pull_request`
run is not programmed at all while the PR is `CONFLICTING` (`mergeable: CONFLICTING`,
`potentialMergeCommit: null`) — so the first observation came from `workflow_dispatch` on a
probe branch carrying the same job. Both unknowns the image README could not settle came
back resolved: Chocolatey's FFmpeg does carry `drawtext` and the media tests pass with it,
and the runner's PATH really lacks `mv` and `sleep`, which is what the two coreutils
exclusions are for.

```
windows-host  498 pass / 17 skip / 0 fail   Ran 515 tests across 78 files. [84.18s]
test (ubuntu) 560 pass /  5 skip / 0 fail   Ran 565 tests across 85 files. [67.24s]
```

The ubuntu column is the point of widening the Windows one: the port changed 100+ files
and the Linux suite still said 0 fail, so none of it was Linux regressions dressed up as
Windows support. The Windows run had 13 more skips than this host's simulation predicted
and 2 fewer passing tests, consistent with the sandbox cluster gating itself off in the
absence of a Linux-image-capable daemon — the Moby on `windows-latest` serves Windows
containers, and `isymcp-sandbox` is a Linux image.

Updated 2026-11-06 (later, first PR-branch run): after the merge was pushed, the real
`pull_request` run `42207486395` on `86b628c3` programmed normally (the PR stopped being
`CONFLICTING`), and **`windows-host` failed twice while `test (ubuntu)` passed both times** —
666 tests across 102 files, 92.88 s then 107.34 s. It was not the same test both times:

```
attempt 1  (fail) composer-selection > settings read waits for the usable composer control   [2663.32ms]
attempt 2  (fail) cli-e2e            > tunnel status and server lifecycle                     [10666.32ms]
attempt 2  (fail) codex-sessions     > procesos concurrentes no pierden escrituras (revoke)   [103.62ms]
```

That spread is the honest signal the widening was meant to buy: these are not capability
gaps like `tmux`, and they do not fail here.

**Root cause of the registry failure, reproduced on this host and fixed.** The runner died
with `EPERM: operation not permitted, rename '<home>/codex-sessions.json.tmp-<pid>' ->
'...codex-sessions.json'` (`errno -4048`, `src/codex-sessions.ts:102` before the fix). Two
separate Windows behaviours, both measured here with concurrent processes:

- `withRegistryLock` acquired the lock with `openSync(lock, "wx")` and re-ran anything that
  was not `EEXIST`. When another process already *holds* the lock file, Windows reports
  `EPERM` (`ERROR_ACCESS_DENIED`), not `EEXIST` — so the second writer died instead of
  waiting. 3 of 4 spawned writers exited on that line. The exclusion was not an exclusion.
- Renaming over a destination another process has open fails, because `MoveFileEx` needs
  delete access and a reader opens the registry without `FILE_SHARE_DELETE`. One writer
  against three reading processes: **2490 `EPERM` vs 325 published**, and every reader
  succeeded — the collision is writer-vs-open-handle, never reader-vs-reader. With the same
  contention and a bounded retry: **0 failures, 46 recoveries**.

`src/codex-sessions.ts` now treats `EPERM` as "lock busy" only while the lock file actually
exists (a real ACL problem on `bridgeHome` still raises immediately rather than ageing out
against the 10 s deadline), and publishes through `publishRegistry`, which retries the
rename with a short backoff and **re-throws when it still will not land** — a revocation
that never reaches disk has to stay a visible failure, never an OK. The temp file carries
session tokens, so it is now unlinked on the error path too.

`tests/codex-sessions.test.ts` adds the detector, which fails against the pre-fix source on
this host with the runner's own `EPERM` (`1 fail`) and passes after (`12 pass / 0 fail`). The
pre-existing 4-writer test had never caught this here, only on the runner.

**Attempt 1 is a budget, not a product property.** `readComposerSettings` takes `timeoutMs`
as a ceiling for each Playwright wait, and the test passed 1000 ms while the whole read
completed with zero retries in **914.99 ms / 985.27 ms** here under six concurrent Chrome
instances — a 15 ms margin, and `timeoutMs: 1000` appears nowhere else in the repo (every
other caller uses the 70 s default). The budget moved to 5000 ms; the two asserted
properties (tolerating the trigger that the fixture enables at 100 ms, and scoping to the
owning `form`) are unchanged, and no assertion was relaxed.

**Attempt 2's `panel start` exit 1 is NOT_DEMONSTRATED as the same cause.** The test asserts
only `exitCode` and `stdout`, so the CLI's reason never reaches the log — the same
silence-swallowing shape as `readComposerSettings`, whose internal error is discarded into an
all-null object at `src/chatgpt-settings.ts:208`. The composer test now sets `ISYMCP_DEBUG=1`
(it has exactly one reader in the tree) so a repeat prints the message instead of five
nulls. If `panel start` fails again after the registry fix, that is the next thing to
instrument.
