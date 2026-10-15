# ISyMCP on Windows

ISyMCP's CLI, HTTP bridge, panel, browser integration, session storage, and
tunnel client can run on a Windows host. Sandboxed commands can run as native
PowerShell or inside the Docker Desktop Linux fallback. Native Windows mode
delegates enforcement to Codex CLI's documented permission profiles and
restricted-token sandbox.

## Requirements

- Windows 10/11 x64.
- Bun 1.4.2 or newer.
- Codex CLI for native PowerShell execution, or Docker Desktop using its Linux
  engine for the Linux command fallback.
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

Restart the MCP server after changing the setting. On first use, Codex CLI may
ask Windows to provision its elevated sandbox users and network rules. Accept
that setup to run native commands; if setup is unavailable, execution fails
closed. This works independently of the Windows Sandbox feature, which is not
available on Windows Home. See [Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing)
and the [permission profile guide](https://learn.chatgpt.com/docs/permissions).

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

The first tunnel connection needs the tunnel ID and runtime API key files
issued for your account. Keep those files in your Windows user profile, then
install the pinned Windows client and copy the credentials into ISyMCP's ACL
protected home:

```powershell
bun run scripts/install-tunnel.ts --tunnel-file "$env:USERPROFILE\Development\tunnel.txt" --key-file "$env:USERPROFILE\Development\runtime-key.txt"
isymcp tunnel connect
```

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

The Windows-specific CI job and regression cases are included in this change;
they have not been run in this session. Docker-backed execution and native
Codex Windows sandbox execution are both **NOT_DEMONSTRATED** in this checkout.
The native sandbox requires the installed Codex CLI and its one-time Windows
provisioning. Do not treat Linux-container results as evidence for Windows-only
APIs.
