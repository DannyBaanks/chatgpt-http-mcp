import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "../codex-sessions";
import type { AppConfig } from "../config";
import { readComposerSettings } from "../chatgpt-settings";
import { canonicalConversationUrl, sendWebTurn, withWebLock } from "../web-turn";
import { normalizeTaskInput, parseResponsesInput, type TaskInputItem } from "./input";
import { assertWebSelection, WebTaskError } from "./selection";
import { decodeToolReply, nativeToolChoice, nativeTools, toolPrompt, type NativeCall } from "./tools";

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
interface State {
  url: string; input: TaskInputItem[]; instructions: string; pending?: string;
  awaiting?: { turnId: string; call: NativeCall; registryFingerprint: string; step: number };
}
interface Turn { fingerprint: string; phase: "prepared" | "attempted" | "done" | "failed"; response?: Record<string, any>; error?: { type: string; status: number; message: string } }
interface Dependencies { dir?: string; send?: typeof sendWebTurn; readSettings?: typeof readComposerSettings }

/** Sequential native requests per Codex turn. Codex executes; the adapter correlates. */
export async function runTaskTurn(req: Request, body: Record<string, any>, config: AppConfig,
  makeResponse: (model: string, text: string, prompt: string) => Record<string, any>, deps: Dependencies = {},
): Promise<{ body: Record<string, any>; replayed: boolean }> {
  const identity = resolveTaskIdentity(req, body);
  const parsed = parseResponsesInput(body); // validate before persistence/browser interaction
  const choice = nativeToolChoice(body.tool_choice);
  const registry = nativeTools(parsed.declarations);
  const registryFingerprint = hash(stable(parsed.declarations));
  const protocol = toolPrompt(registry, choice);
  const effort = body.reasoning?.effort ?? body.reasoning_effort ?? "high";
  assertWebSelection(body.model, effort);
  const input = normalizeTaskInput(body.input);
  const instructions = body.instructions ?? "";
  const { stream, client_metadata, prompt_cache_key, ...semanticBody } = body;
  const fingerprint = hash(stable({ ...semanticBody, input }));
  const dir = deps.dir ?? join(bridgeHome(), "codex-responses");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const taskPath = join(dir, `task-${identity.key}.json`);
  const turnPath = join(dir, `turn-${hash(identity.key + identity.turnId)}.json`);
  const requestPath = join(dir, `request-${hash(JSON.stringify([identity.key, identity.turnId, fingerprint]))}.json`);
  const leasePath = join(dir, `lease-${identity.key}`);
  return withWebLock(async () => {
    let fd: number;
    try { fd = openSync(leasePath, "wx", 0o600); }
    catch (error: any) {
      if (error.code === "EEXIST") throw new WebTaskError("web_task_busy", 409, "task lease exists; a crash requires inspection, not automatic replay");
      throw new WebTaskError("web_task_state_unavailable", 503, "cannot create private task lease");
    }
    try {
      const previous = read<Turn>(requestPath);
      if (previous && (typeof previous.fingerprint !== "string" || !["prepared", "attempted", "done", "failed"].includes(previous.phase) || (previous.phase === "done" && (!previous.response || typeof previous.response.output_text !== "string"))))
        throw new WebTaskError("web_task_state_invalid", 503, "invalid durable turn record");
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new WebTaskError("web_turn_identity_conflict", 409, "same turn has different request content");
        if (previous.phase === "done" && previous.response) return { body: previous.response, replayed: true };
        if (previous.phase === "failed" && previous.error) throw new WebTaskError(previous.error.type, previous.error.status, previous.error.message);
        throw new WebTaskError("web_turn_ambiguous", 409, "previous request did not commit a response; it will not be resent");
      }
      const task = read<State>(taskPath);
      if (task && (typeof task.url !== "string" || typeof task.instructions !== "string" || !Array.isArray(task.input) || task.input.some((i) => !i || (!("type" in i) && (typeof i.role !== "string" || typeof i.text !== "string"))) || (!task.pending && canonicalConversationUrl(task.url) !== task.url)))
        throw new WebTaskError("web_task_state_invalid", 503, "invalid durable task record");
      if (task?.pending) throw new WebTaskError("web_task_pending", 409, "a previous submit is unresolved; new turns are blocked");
      const priorRound = read<Turn>(turnPath);
      if (priorRound) {
        if (priorRound.fingerprint === fingerprint) {
          // Also recognizes durable records created by the older text-only adapter.
          if (priorRound.phase === "done" && priorRound.response) return { body: priorRound.response, replayed: true };
          if (priorRound.phase === "failed" && priorRound.error) throw new WebTaskError(priorRound.error.type, priorRound.error.status, priorRound.error.message);
          throw new WebTaskError("web_turn_ambiguous", 409, "previous round did not commit; it will not be resent");
        }
        if (!task?.awaiting || task.awaiting.turnId !== identity.turnId || priorRound.phase !== "done")
          throw new WebTaskError("web_turn_identity_conflict", 409, "same turn has different content without a pending native call");
      }
      let delta = input;
      let unconfirmedCall: NativeCall | undefined;
      if (task) {
        let prefix = task.input;
        const newTurnWithCall = task.awaiting && task.awaiting.turnId !== identity.turnId;
        // An interrupted Codex client can retain or omit precisely its last
        // requested call. Earlier committed history remains mandatory.
        if (newTurnWithCall && stable(task.input.at(-1)) === stable(task.awaiting!.call) &&
          stable(input.slice(0, task.input.length)) !== stable(task.input)) prefix = task.input.slice(0, -1);
        if (task.instructions !== instructions || input.length <= prefix.length || stable(input.slice(0, prefix.length)) !== stable(prefix))
          throw new WebTaskError("web_context_mismatch", 409, "input is not a continuation of the committed Codex task state");
        delta = input.slice(prefix.length);
        if (newTurnWithCall) {
          if (delta.some(i => "type" in i || (i.role !== "user" && i.role !== "developer")))
            throw new WebTaskError("web_tool_result_mismatch", 409, "a new turn may abandon an unconfirmed call only through new user/developer text");
          unconfirmedCall = task.awaiting!.call;
        }
      }
      if (task?.awaiting && !unconfirmedCall) {
        const expectedType = task.awaiting.call.type === "function_call" ? "function_call_output" : "custom_tool_call_output";
        const output = delta[0];
        if (task.awaiting.turnId !== identity.turnId || registryFingerprint !== task.awaiting.registryFingerprint || delta.slice(1).some(i => "type" in i || i.role === "assistant") ||
          !output || !("type" in output) || output.type !== expectedType || output.call_id !== task.awaiting.call.call_id)
          throw new WebTaskError("web_tool_result_mismatch", 409, "result must match the single pending call, registry and Codex turn");
      } else if (delta.some(i => "type" in i)) {
        throw new WebTaskError("web_tool_result_mismatch", 409, "unsolicited native call or result in a task without a pending call");
      }
      const notice = unconfirmedCall ? `[Unconfirmed prior native call]\n${JSON.stringify({ type: unconfirmedCall.type, call_id: unconfirmedCall.call_id, name: unconfirmedCall.name, namespace: unconfirmedCall.namespace })}\nCodex opened a new turn without returning a matching result for this call. Execution status is unknown: it may or may not have executed. Do not claim success or failure. Do not retry this call automatically. Continue with the new user/developer text.\n\n` : "";
      const prompt = notice + parseResponsesInput({ instructions: task ? undefined : instructions,
        input: delta.map((i) => "type" in i ? i : ({ type: "message", role: i.role, content: i.text })) }).prompt;
      const record: Turn = { fingerprint, phase: "prepared" };
      const persistRound = () => { write(requestPath, record); write(turnPath, record); };
      persistRound();
      let attempted = false;
      let target = task?.url;
      const pendingState = () => ({ ...(task ?? { input: [], instructions }), url: target ?? "", pending: identity.turnId });
      try {
        let nextPrompt = protocol + prompt;
        let result: Awaited<ReturnType<typeof sendWebTurn>>;
        let answer: ReturnType<typeof decodeToolReply> | undefined;
        for (let lookup = 0; ; lookup++) {
          result = await (deps.send ?? sendWebTurn)(nextPrompt, {
          statePath: config.browserStatePath, browser: config.browser, headed: config.browserHeaded,
          deadlineMs: config.webTurnDeadlineMs, connector: "", submitOnce: true,
          navigate: target ? { to: "conversation", url: target } : { to: "new" },
          beforeSubmit: async (page) => {
            const current = canonicalConversationUrl(page.url());
            if (target ? current !== target : current !== null)
              throw new WebTaskError("web_task_navigation_mismatch", 409, "browser is not at the task's intended conversation");
            assertWebSelection(body.model, effort, await (deps.readSettings ?? readComposerSettings)(page));
          },
          onSubmitAttempt: () => {
            attempted = true;
            record.phase = "attempted";
            persistRound();
            write(taskPath, pendingState());
          },
          });
          const observedUrl = canonicalConversationUrl(result.url);
          if (!result.submitted || !result.text || !observedUrl || (target && observedUrl !== target))
            throw new WebTaskError("web_turn_ambiguous", 409, "submit/capture/conversation identity did not commit; no resend permitted");
          target = observedUrl;
          if (!registry.size) break;
          answer = decodeToolReply(result.text, registry, choice);
          if (answer.kind !== "describe_tools") break;
          if (lookup >= 3) throw new WebTaskError("web_tool_schema_limit", 502, "too many tool schema requests in one native round");
          nextPrompt = protocol + `Exact requested schemas:\n${answer.schemas}\nContinue the pending task using the response contract.`;
        }
        const url = canonicalConversationUrl(result!.url);
        if (!url || (task && url !== task.url))
          throw new WebTaskError("web_turn_ambiguous", 409, "submit/capture/conversation identity did not commit; no resend permitted");
        const ownerPath = join(dir, `owner-${hash(url)}.json`);
        try {
          const ownerFd = openSync(ownerPath, "wx", 0o600);
          try { writeFileSync(ownerFd, JSON.stringify({ task: identity.key })); } finally { closeSync(ownerFd); }
        } catch (error: any) {
          if (error.code !== "EEXIST" || read<{ task: string }>(ownerPath)?.task !== identity.key)
            throw new WebTaskError("web_task_conversation_conflict", 409, "conversation ownership is not unique");
        }
        const text = answer?.kind === "final" ? answer.text : answer?.kind === "call" ? "" : result!.text;
        const response = makeResponse(body.model, text, prompt);
        let emitted: TaskInputItem = { role: "assistant", text };
        let awaiting: State["awaiting"];
        if (answer?.kind === "call") {
          const step = (unconfirmedCall ? 0 : task?.awaiting?.step ?? 0) + 1;
          if (step > 64) throw new WebTaskError("web_tool_round_limit", 409, "native call limit reached for this turn");
          response.output = [{ id: `item_${crypto.randomUUID().replace(/-/g, "")}`, ...answer.call, status: "completed" }];
          response.output_text = "";
          emitted = answer.call;
          awaiting = { turnId: identity.turnId, call: answer.call, registryFingerprint, step };
        }
        response.metadata = { isymcp_conversation: url, isymcp_model_state: "visible_state_verified", isymcp_model: "GPT-5.6 Sol", isymcp_effort: "High" };
        write(taskPath, { url, input: [...input, emitted], instructions, ...(awaiting ? { awaiting } : {}) });
        record.phase = "done"; record.response = response; persistRound();
        return { body: response, replayed: false };
      } catch (error) {
        if (attempted) {
          // Even a partial commit must keep later requests blocked.
          try { write(taskPath, pendingState()); } catch { /* prepared/attempted turn and lease still require inspection */ }
          if (error instanceof WebTaskError && error.type.startsWith("web_tool_")) throw error;
          throw new WebTaskError("web_turn_ambiguous", 409, "submit was attempted but no response committed; inspect task state before recovery");
        }
        const typed = error instanceof WebTaskError ? error : new WebTaskError("web_turn_not_submitted", 502, "browser failed before submission");
        record.phase = "failed"; record.error = { type: typed.type, status: typed.status, message: typed.message }; persistRound();
        throw typed;
      }
    } finally { closeSync(fd); unlinkSync(leasePath); }
  });
}
