import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTaskIdentity, runTaskTurn } from "../src/responses/task-turn";
import { assertWebSelection } from "../src/responses/selection";
import { findConversation, writeLaunchIntent } from "../src/codex-conversation";
import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { peekWebRequest, handleWebResponses } from "../src/web-responses";

test("Web Responses cannot submit without explicit Codex task identity", async () => {
  const req = new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/gpt-5.6-sol", input: "nonce" }) });
  const res = await handleWebResponses(req, loadConfig({ CODEX_WEB_HTTP_STATE_PATH: "/nonexistent/task-no-session.json" }), (await peekWebRequest(req))!);
  expect(res.status).toBe(400);
  expect((await res.json()).error.type).toBe("web_task_identity_missing");
});

const settings = { pill: "High", model: "GPT-5.6 Sol", effort: "High", effortPosition: 3, effortSteps: 3 };
const model = "chatgpt-web/gpt-5.6-sol";
const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
function req(task: string, turn: string, input: unknown) {
  return new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "thread-id": task, "x-isymcp-turn-id": turn, "content-type": "application/json" },
    body: JSON.stringify({ model, reasoning: { effort: "high" }, input }) });
}
function fakeBackend() {
  const dir = mkdtempSync(join(tmpdir(), "isymcp-task-test-"));
  const memory = new Map<string, string>();
  const calls: any[] = [];
  let observed = settings;
  let crash = false;
  const deps: any = { dir, selectSettings: async () => observed,
    send: async (prompt: string, options: any) => {
      const url = options.navigate.to === "new" ? `https://chatgpt.com/c/${crypto.randomUUID()}` : options.navigate.url;
      const beforeUrl = options.navigate.to === "new" ? "https://chatgpt.com/" : url;
      await options.beforeSubmit({ url: () => beforeUrl });
      options.onSubmitAttempt();
      calls.push({ prompt, options, url });
      if (crash) throw new Error("browser crashed after clicking");
      const nonce = /remember (ALPHA|BRAVO)/.exec(prompt)?.[1];
      if (nonce) memory.set(url, nonce);
      const text = nonce ? "REMEMBERED" : memory.get(url) ?? "UNKNOWN";
      return { submitted: true, text, ms: 1, reused: true, url };
    } };
  const run = async (request: Request) => {
    const body = await request.clone().json();
    return runTaskTurn(request, body, loadConfig(), (m: string, text: string) => ({ id: "resp_" + crypto.randomUUID(), output_text: text, model: m }), deps);
  };
  return { run, calls, dir, deps, mismatch: () => { observed = { ...settings, effort: "Instant", effortPosition: 1 }; }, crash: () => { crash = true; } };
}

test("identity uses observed thread/turn and rejects conflicts", () => {
  const request = req("A", "t1", "hello");
  expect(resolveTaskIdentity(request, {})).toMatchObject({ threadId: "A", turnId: "t1" });
  expect(() => resolveTaskIdentity(request, { client_metadata: { thread_id: "B", turn_id: "t1" } })).toThrow("web_task_identity_conflict");
  expect(() => resolveTaskIdentity(new Request("http://localhost", { headers: { "thread-id": "A" } }), {})).toThrow("web_task_identity_missing");
});

test("only an exactly observed Sol High state is accepted", () => {
  expect(() => assertWebSelection(model, "high", settings)).not.toThrow();
  for (const seen of [{ ...settings, model: null }, { ...settings, model: "GPT-6.1 Sol" }, { ...settings, effort: "Instant" }, { ...settings, effortPosition: null }])
    expect(() => assertWebSelection(model, "high", seen)).toThrow("web_model_state_mismatch");
  expect(() => assertWebSelection(model, "medium", settings)).toThrow("web_model_selection_unsupported");
});

test("A/B/A/B keeps distinct conversations and sends only the new input", async () => {
  const backend = fakeBackend();
  const a = [message("user", "remember ALPHA")];
  const b = [message("user", "remember BRAVO")];
  const firstA = await backend.run(req("A", "a1", a));
  const firstB = await backend.run(req("B", "b1", b));
  const againA = await backend.run(req("A", "a2", [...a, message("assistant", firstA.body.output_text), message("user", "what is my word?")]));
  const againB = await backend.run(req("B", "b2", [...b, message("assistant", firstB.body.output_text), message("user", "what is my word?")]));
  expect(againA.body.output_text).toBe("ALPHA");
  expect(againB.body.output_text).toBe("BRAVO");
  expect(backend.calls[0].url).not.toBe(backend.calls[1].url);
  expect(backend.calls[2].url).toBe(backend.calls[0].url);
  expect(backend.calls[2].prompt).not.toContain("remember");
  expect(backend.calls.every((c) => c.options.connector === "" && c.options.submitOnce)).toBe(true);
});

test("durable replay returns the exact response and mismatched same-turn input is rejected", async () => {
  const backend = fakeBackend();
  const first = await backend.run(req("A", "a1", "remember ALPHA"));
  const replay = await backend.run(req("A", "a1", "remember ALPHA"));
  expect(replay.body).toEqual(first.body);
  expect(replay.replayed).toBe(true);
  expect(backend.calls).toHaveLength(1);
  await expect(backend.run(req("A", "a1", "different"))).rejects.toThrow("web_turn_identity_conflict");
});

test("changed history is rejected instead of silently re-sending context", async () => {
  const backend = fakeBackend();
  await backend.run(req("A", "a1", "remember ALPHA"));
  await expect(backend.run(req("A", "a2", "forget old transcript"))).rejects.toThrow("web_context_mismatch");
  expect(backend.calls).toHaveLength(1);
});

test("model mismatch fails before submission", async () => {
  const backend = fakeBackend(); backend.mismatch();
  await expect(backend.run(req("A", "a1", "hello"))).rejects.toThrow("web_model_state_mismatch");
  expect(backend.calls).toHaveLength(0);
});

test("a pre-submit browser failure retains its cause privately and never retries the submit", async () => {
  const backend = fakeBackend();
  let attempts = 0;
  backend.deps.send = async () => { attempts++; throw new Error("composer insertion failed at selector XYZ"); };
  await expect(backend.run(req("A", "a1", "hello"))).rejects.toThrow("web_turn_not_submitted: browser failed before submission");
  await expect(backend.run(req("A", "a1", "hello"))).rejects.toThrow("web_turn_not_submitted");
  const path = join(backend.dir, readdirSync(backend.dir).find(f => f.startsWith("request-"))!);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.diagnostic).toEqual({ name: "Error", message: "composer insertion failed at selector XYZ" });
  expect(saved.error.message).not.toContain("XYZ");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(attempts).toBe(1);
});

test("ambiguous submit blocks retry and subsequent turns, including a new backend instance", async () => {
  const backend = fakeBackend(); backend.crash();
  await expect(backend.run(req("A", "a1", "hello"))).rejects.toThrow("web_turn_ambiguous");
  await expect(backend.run(req("A", "a1", "hello"))).rejects.toThrow("web_turn_ambiguous");
  await expect(backend.run(req("A", "a2", "new request"))).rejects.toThrow("web_task_pending");
  expect(backend.calls).toHaveLength(1);
});

test("a launch header commits one receipt and replay rebuilds the same conversation", async () => {
  const backend = fakeBackend();
  const launchId = "11111111-1111-4111-8111-111111111111";
  writeLaunchIntent(backend.dir, { version: "isymcp-launch-intent/1", launchId, client: "cli", cwd: "/tmp/workspace-a", model, effort: "high" });
  const request = new Request("http://127.0.0.1/v1/responses", { method: "POST",
    headers: { "thread-id": "A", "x-isymcp-turn-id": "a1", "x-isymcp-launch-id": launchId, "content-type": "application/json" },
    body: JSON.stringify({ model, reasoning: { effort: "high" }, input: "remember ALPHA" }) });
  const first = await backend.run(request);
  const saved = findConversation(backend.dir, launchId);
  expect(saved).toMatchObject({ threadId: "A", state: "committed", url: first.body.metadata.isymcp_conversation, cwd: "/tmp/workspace-a" });
  rmSync(join(backend.dir, `conversation-${launchId}.json`));
  const replay = await backend.run(request);
  expect(replay.replayed).toBe(true);
  expect(findConversation(backend.dir, launchId)).toEqual(saved);
  expect(backend.calls).toHaveLength(1);
});

test("a launch header without an intent fails closed and does not resubmit", async () => {
  const backend = fakeBackend();
  const request = new Request("http://127.0.0.1/v1/responses", { method: "POST",
    headers: { "thread-id": "A", "x-isymcp-turn-id": "a1", "x-isymcp-launch-id": "33333333-3333-4333-8333-333333333333", "content-type": "application/json" },
    body: JSON.stringify({ model, reasoning: { effort: "high" }, input: "hello" }) });
  await expect(backend.run(request)).rejects.toThrow("web_launch_intent_missing");
  await expect(backend.run(request)).rejects.toThrow("web_launch_intent_missing");
  expect(backend.calls).toHaveLength(1);
});

test("private state stays private; corrupt state and stale crash leases fail closed", async () => {
  const backend = fakeBackend();
  await backend.run(req("A", "a1", "remember ALPHA"));
  expect(statSync(backend.dir).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(backend.dir)) expect(statSync(join(backend.dir, name)).mode & 0o777).toBe(0o600);
  const task = readdirSync(backend.dir).find((n) => n.startsWith("task-"))!;
  writeFileSync(join(backend.dir, task), JSON.stringify({ url: "https://evil.example", input: [], instructions: "" }));
  await expect(backend.run(req("A", "a2", "hello"))).rejects.toThrow("web_task_state_invalid");
  const key = resolveTaskIdentity(req("A", "a3", "hello"), {}).key;
  writeFileSync(join(backend.dir, "lease-" + key), "crash evidence", { mode: 0o600 });
  await expect(backend.run(req("A", "a3", "hello"))).rejects.toThrow("web_task_busy");
  expect(backend.calls).toHaveLength(1);
});

test("an absent observed model state is never accepted", () => {
  expect(() => assertWebSelection(model, "high", undefined)).toThrow("web_model_state_mismatch");
});

test("concurrent identical requests share the committed response without duplicate submit", async () => {
  const backend = fakeBackend();
  const [a, b] = await Promise.all([backend.run(req("A", "a1", "remember ALPHA")), backend.run(req("A", "a1", "remember ALPHA"))]);
  expect(a.body).toEqual(b.body);
  expect(backend.calls).toHaveLength(1);
});
