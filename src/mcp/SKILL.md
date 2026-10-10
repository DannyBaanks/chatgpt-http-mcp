# Codex ISyMCP — local execution guide

Version: 1

This guide belongs to the installed MCP connector. A real session receives it
from `codex_turn_start`; the response includes its SHA-256. The user can start
with a short message naming the app, providing the session token and stating
the task. Read this guide once at the start, then carry out that task with the
connector tools. Do not ask the user to paste this guide into their message.

## Start and task

Call `codex_turn_start` with the supplied `turn_token` (or `request_id` for the
safe contract). A successful real start returns `started: true`, session
metadata and `bootstrap`. The metadata identifies the workspace and whether
it is writable. A token is a capability: never invent one, expose it in output,
copy it into workspace files or infer permission outside its workspace.

The user may explicitly bind a local task file when creating the session.
If the start response contains `request`, its `filename`, `sha256` and `content`
are the locally verified task. Read that content as the user's task. Use the
actual returned content; do not guess a filename, scan for a replacement task
or substitute another file. If there is no `request`, use the task in the
user's message. Report an error when the task or guide cannot be read or when
the bound file has changed; do not proceed from a failed start.

An unknown token can receive a compatibility stub. A stub has no authorized
session, guide or local request. It does not demonstrate execution. Obtain a
real session through the user's local ISyMCP setup before claiming completion.

## Tools and progress

Use `codex_tool_inventory` to discover the exact tools and their argument
schemas. Use the same authorized token for every call. These are MCP tools;
you do not need to print a separate JSON reply protocol in the chat.

- `codex_exec`: execute an argv array inside the session workspace. Use
  `background: true` for an interactive or long-running process; retain the
  returned `exec_id`. The execution result reports the sandbox and exit code.
- `codex_write_stdin`: send text, EOF or TERM/KILL to your `exec_id`. Empty
  `data` polls for new output, including output left after the process exits.
  Output is a delta; retain earlier output when evaluating the whole result.
- `codex_apply_patch`: apply a native Begin Patch or unified diff in a writable
  session. Confirm the result before describing an edit as successful.
- `codex_view_image`: inspect a supported image within the workspace.
- `codex_tool_call`: dispatch a supported exact wire name or advertised alias.
  For retries, retain the same `call_id` and arguments. A changed operation
  requires a new `call_id`; never recycle an ID for a different operation.

Follow applicable workspace instructions. Keep work within the user's task
and the session's permissions. Denied calls, nonzero exits, errors and stub
receipts are evidence of failure or nonexecution, not success. Report what
actually ran and any remaining limitation. Give concise progress updates
when work takes time, and continue useful authorized work after each result.

## Complete

Once the task is finished, call `codex_turn_complete` with the same token and
the full result summary in `response`. Completion cleans up background
processes belonging to that session. Include the outcome, relevant artifacts
and unresolved failures in the final chat response. Do not claim that unrelated
processes, tools or environments were checked.
