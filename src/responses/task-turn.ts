import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "../codex-sessions";
import type { AppConfig } from "../config";
import { readComposerSettings } from "../chatgpt-settings";
import { canonicalConversationUrl, sendWebTurn, withWebLock } from "../web-turn";
import { parseResponsesInput } from "./input";
import { assertWebSelection, WebTaskError } from "./selection";

export interface TaskIdentity { key: string; threadId: string; turnId: string }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function one(values: unknown[], field: string, required = false): string {
  const present = values.filter((v) => v !== undefined && v !== null);
  if (present.some((v) => typeof v !== "string" || !v.trim() || v.length > 256))
    throw new WebTaskError("web_task_identity_invalid", 400, `invalid ${field}`);
  const ids = new Set(present as string[]);
  if (ids.size > 1) throw new WebTaskError("web_task_identity_conflict", 400, `conflicting ${field}`);
  if (!ids.size && required) throw new WebTaskError("web_task_identity_missing", 400, `${field} is required`);
  return [...ids][0] ?? "";
}
function metadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* typed error below */ }
  throw new WebTaskError("web_task_identity_invalid", 400, "invalid turn metadata");
}
export function resolveTaskIdentity(req: Request, body: Record<string, any>): TaskIdentity {
  const client = metadata(body.client_metadata);
  const headerMeta = metadata(req.headers.get("x-codex-turn-metadata"));
  const bodyMeta = metadata(client["x-codex-turn-metadata"]);
  const threadId = one([req.headers.get("thread-id"), client.thread_id, headerMeta.thread_id, bodyMeta.thread_id], "thread_id", true);
  const turnId = one([req.headers.get("x-isymcp-turn-id"), client.turn_id, headerMeta.turn_id, bodyMeta.turn_id], "turn_id", true);
  const installation = one([client["x-codex-installation-id"], headerMeta.installation_id, bodyMeta.installation_id], "installation_id");
  const agent = one([headerMeta.agent_name, bodyMeta.agent_name], "agent_name");
  return { key: hash(JSON.stringify([installation, threadId, agent || "/root"])), threadId, turnId };
}
interface Item { role: string; text: string }
function items(input: any): Item[] {
  if (typeof input === "string") return [{ role: "user", text: input }];
  return input.filter((i: any) => i.type !== "additional_tools").map((i: any) => ({
    role: i.type === "input_text" ? "user" : i.role,
    text: i.type === "input_text" ? i.text : typeof i.content === "string" ? i.content : i.content.map((p: any) => p.text).join(""),
  }));
}
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function read<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new WebTaskError("web_task_state_invalid", 503, "private task state cannot be read; inspect it before recovery"); }
}
function write(path: string, value: unknown) {
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}
interface State { url: string; input: Item[]; instructions: string; pending?: string }
interface Turn { fingerprint: string; phase: "prepared" | "attempted" | "done" | "failed"; response?: Record<string, any>; error?: { type: string; status: number; message: string } }
interface Dependencies { dir?: string; send?: typeof sendWebTurn; readSettings?: typeof readComposerSettings }

/** One text request per Codex turn. No tool execution or blind recovery. */
export async function runTaskTurn(req: Request, body: Record<string, any>, config: AppConfig,
  makeResponse: (model: string, text: string, prompt: string) => Record<string, any>, deps: Dependencies = {},
): Promise<{ body: Record<string, any>; replayed: boolean }> {
  const identity = resolveTaskIdentity(req, body);
  parseResponsesInput(body); // validate every part before persistence or browser interaction
  const effort = body.reasoning?.effort ?? body.reasoning_effort ?? "high";
  assertWebSelection(body.model, effort);
  const input = items(body.input);
  const instructions = body.instructions ?? "";
  const { stream, client_metadata, prompt_cache_key, ...semanticBody } = body;
  const fingerprint = hash(stable(semanticBody));
  const dir = deps.dir ?? join(bridgeHome(), "codex-responses");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const taskPath = join(dir, `task-${identity.key}.json`);
  const turnPath = join(dir, `turn-${hash(identity.key + identity.turnId)}.json`);
  const leasePath = join(dir, `lease-${identity.key}`);
  return withWebLock(async () => {
    let fd: number;
    try { fd = openSync(leasePath, "wx", 0o600); }
    catch (error: any) {
      if (error.code === "EEXIST") throw new WebTaskError("web_task_busy", 409, "task lease exists; a crash requires inspection, not automatic replay");
      throw new WebTaskError("web_task_state_unavailable", 503, "cannot create private task lease");
    }
    try {
      const previous = read<Turn>(turnPath);
      if (previous && (typeof previous.fingerprint !== "string" || !["prepared", "attempted", "done", "failed"].includes(previous.phase) || (previous.phase === "done" && (!previous.response || typeof previous.response.output_text !== "string"))))
        throw new WebTaskError("web_task_state_invalid", 503, "invalid durable turn record");
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new WebTaskError("web_turn_identity_conflict", 409, "same turn has different request content");
        if (previous.phase === "done" && previous.response) return { body: previous.response, replayed: true };
        if (previous.phase === "failed" && previous.error) throw new WebTaskError(previous.error.type, previous.error.status, previous.error.message);
        throw new WebTaskError("web_turn_ambiguous", 409, "previous request did not commit a response; it will not be resent");
      }
      const task = read<State>(taskPath);
      if (task && (typeof task.url !== "string" || typeof task.instructions !== "string" || !Array.isArray(task.input) || task.input.some((i) => !i || typeof i.role !== "string" || typeof i.text !== "string") || (!task.pending && canonicalConversationUrl(task.url) !== task.url)))
        throw new WebTaskError("web_task_state_invalid", 503, "invalid durable task record");
      if (task?.pending) throw new WebTaskError("web_task_pending", 409, "a previous submit is unresolved; new turns are blocked");
      let delta = input;
      if (task) {
        if (task.instructions !== instructions || !Array.isArray(task.input) || input.length <= task.input.length || stable(input.slice(0, task.input.length)) !== stable(task.input))
          throw new WebTaskError("web_context_mismatch", 409, "input is not a continuation of the committed Codex task state");
        delta = input.slice(task.input.length);
      }
      const prompt = parseResponsesInput({ instructions: task ? undefined : instructions,
        input: delta.map((i) => ({ type: "message", role: i.role, content: i.text })) }).prompt;
      const record: Turn = { fingerprint, phase: "prepared" };
      write(turnPath, record);
      let attempted = false;
      try {
        const result = await (deps.send ?? sendWebTurn)(prompt, {
          statePath: config.browserStatePath, browser: config.browser, headed: config.browserHeaded,
          deadlineMs: config.webTurnDeadlineMs, connector: "", submitOnce: true,
          navigate: task ? { to: "conversation", url: task.url } : { to: "new" },
          beforeSubmit: async (page) => {
            const current = canonicalConversationUrl(page.url());
            if (task ? current !== task.url : current !== null)
              throw new WebTaskError("web_task_navigation_mismatch", 409, "browser is not at the task's intended conversation");
            assertWebSelection(body.model, effort, await (deps.readSettings ?? readComposerSettings)(page));
          },
          onSubmitAttempt: () => {
            attempted = true;
            record.phase = "attempted";
            write(turnPath, record);
            write(taskPath, { ...(task ?? { url: "", input: [], instructions }), pending: identity.turnId });
          },
        });
        const url = canonicalConversationUrl(result.url);
        if (!result.submitted || !result.text || !url || (task && url !== task.url))
          throw new WebTaskError("web_turn_ambiguous", 409, "submit/capture/conversation identity did not commit; no resend permitted");
        const ownerPath = join(dir, `owner-${hash(url)}.json`);
        try {
          const ownerFd = openSync(ownerPath, "wx", 0o600);
          try { writeFileSync(ownerFd, JSON.stringify({ task: identity.key })); } finally { closeSync(ownerFd); }
        } catch (error: any) {
          if (error.code !== "EEXIST" || read<{ task: string }>(ownerPath)?.task !== identity.key)
            throw new WebTaskError("web_task_conversation_conflict", 409, "conversation ownership is not unique");
        }
        const response = makeResponse(body.model, result.text, prompt);
        response.metadata = { isymcp_conversation: url, isymcp_model_state: "visible_state_verified", isymcp_model: "GPT-5.6 Sol", isymcp_effort: "High" };
        write(taskPath, { url, input: [...input, { role: "assistant", text: result.text }], instructions });
        record.phase = "done"; record.response = response; write(turnPath, record);
        return { body: response, replayed: false };
      } catch (error) {
        if (attempted) {
          // Even a partial commit must keep later requests blocked.
          try { write(taskPath, { ...(task ?? { url: "", input: [], instructions }), pending: identity.turnId }); } catch { /* prepared/attempted turn and lease still require inspection */ }
          throw new WebTaskError("web_turn_ambiguous", 409, "submit was attempted but no response committed; inspect task state before recovery");
        }
        const typed = error instanceof WebTaskError ? error : new WebTaskError("web_turn_not_submitted", 502, "browser failed before submission");
        record.phase = "failed"; record.error = { type: typed.type, status: typed.status, message: typed.message }; write(turnPath, record);
        throw typed;
      }
    } finally { closeSync(fd); unlinkSync(leasePath); }
  });
}
