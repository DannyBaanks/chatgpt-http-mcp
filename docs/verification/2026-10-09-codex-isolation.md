# Codex routing isolation — verification scope

Observed client: Codex CLI 0.162.0 on Ubuntu 24.04. Measurements and raw
responses are private local artifacts; account state, prompts and conversation
URLs are not committed.

## Demonstrated

- `bun test`: **388 passed, 1 skipped, 0 failed** across 60 files. The skipped
  gate requires the separately installed Video Vision server; it is not
  represented as passed.
- A real native CLI turn, with the bridge offline, executed one `printf`,
  returned exit code 0 and completed. Total duration: 56.299 seconds. Its
  diagnostics included model-catalog timeouts and an `office-bridge` handshake
  failure; they did not show an `isymcp-media` startup error.
- Installer tests execute both entry scripts and the package command against
  explicit fixtures and compare configuration/cache hashes before and after.
  Profile writes belong to ISyMCP; native Codex configuration remains separate.
- CLI entry tests launch the actual ISyMCP command against a controlled child
  executable and local health endpoint. Native selection works with the bridge
  down; Web selection uses the named provider and private catalog.
- A real WebSocket client receives individually parseable, ordered Responses
  events. The former single-frame JSONL payload failed this regression.
- Protocol tests cover function/custom/namespace declarations, validation,
  successive native results, task/turn identity, replay, cancellation, caller
  `tool_choice` and the 64-call boundary. Browser lifecycle tests cover cleanup
  when initialization or replacement fails.

## Startup comparison

Two paired runs used the real CLI with a local Responses stub. No inference
was requested and no tool was executed. Apps, plugins and hooks were disabled
equally in both arms; other MCPs remained configured equally. Process inspection
verified that the media child started only in the enabled arm.

| Pair | Media MCP enabled | Media MCP disabled |
| --- | ---: | ---: |
| 1 | 1.279 s | 1.021 s |
| 2 | 0.816 s | 1.024 s |

The mean difference to the first POST was about 25 ms, with opposite signs
between pairs. This small sample does not establish a consistent slowdown.
It measures startup, not model latency or the cost of processing tool schemas.
Concurrent host activity and warm caches were not controlled.

## NOT_DEMONSTRATED

- The complete GPT-5.6 Web → native Codex execution → Web final-answer canary.
  Recent read-only browser probes saw a loading profile and no usable model
  selector. No message was submitted. This does not prove expired login.
- Native Codex App UI parity or a guided new App conversation.
- Recovery of the old thread while its original daemon still owns its writer
  lock. A different app-server reporting `notLoaded` does not release that lock.
- A causal explanation for all reported latency. A successful native turn and
  a controlled startup comparison do not measure every live network path.

## Evidence hashes

| Private artifact | SHA-256 |
| --- | --- |
| Native connectivity `result.json` | `34f93399ca5d5b63c1a012835508e88ba089679ecca625c018c7c95a4c5c6f43` |
| Paired startup `result.json` | `24db842839dec66b14d5122012c642762e9281b121999e88b51cf39e7f147332` |
| Paired startup `summary.json` | `da6aa1484f37e33cf1fc0559c5247d6db86c84bc757fdc79651bfa782d29a55a` |
| Installer targeted tests | `ca912d6b5e267a78108645d246e8273374d37cb4c55d52ae9f3906b73da2e170` |
| Browser readiness `attempt-2.json` | `ecc5bb8cf015a470e94ce7143f373ac6e8ac475bd24d6e1248773006c113f1e7` |
| Final `unhijack-final-fullsuite-ef2c391d6c354b6e860ef935729f4290.txt` | `2ca4c0696aa1ed7a6a47e1467bcb2edec97c92413c26d82a8cc2f8b1c98f6d85` |
| Installed menu PTY capture | `2eb4c9af378a82c92dc0461c6cd38ece911568c55972ee20982483f069442756` |

The approved milestone plan remains open at its live Web gate. No local test
result is represented as completion of CLI/App Web parity.
