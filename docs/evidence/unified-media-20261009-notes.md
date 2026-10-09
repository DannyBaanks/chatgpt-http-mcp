# Unified Codex ISyMCP media verification

2026-10-09. User explicitly requested adding all existing local media capabilities to their selected Codex ISyMCP plugin. Updated its owning MCP server repository and existing tunnel, not plugin identity or account permissions. Plugin Creator search did not return a backend ID for the selected custom plugin and its personal archive list was empty; no denial inferred and no unrelated package edited.

Implemented shared media registration for main and dedicated MCP entry points; added registered-only paginated discovery. Native tool names preserved; instructions distinguish token-free media from actual Codex turns. Unknown token retains existing stub behavior; missing token on codex_exec still rejects; existing read-only/writable sandbox tests pass.

RED: unified stdio test failed because media_list was missing. GREEN: it sees original tools plus media tools, returns only registered IDs, generates two audio PNGs, and enforces Codex token requirements. Real Angel Engine local smoke through main entry point returns one Video Vision JPEG and two audio PNGs.

Full suite initial default timeout: 290 pass, one failure (existing Unified E2E Smoke Suite hit its 5000 ms limit). Retry with --timeout 15000: 291 pass, zero fail, exit 0. No timeout weakened in product code. Both raw outputs preserved.

Native Tunnel MCP connect/start: alias codex-web-http, same tunnel_6aa79054b69c8191b49df82a1834c4c8, main.ts with original native contract and broker argument, explicit installed Video Vision paths in command environment. Health/ready 200; process running. Native control-plane poll health unknown. Local success does not establish remote ChatGPT tool discovery or execution: NOT_DEMONSTRATED. User needs to refresh schema on existing plugin.

Previous local-media manifest refers to historical commit 86be6ed; its source hashes are expected to differ after this subsequent integration. The new manifest records current files without rewriting old evidence.
