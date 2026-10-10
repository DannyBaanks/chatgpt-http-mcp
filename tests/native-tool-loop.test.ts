import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { runTaskTurn } from "../src/responses/task-turn";
import { buildResponseBody, responseEvents } from "../src/web-responses";

const model = "chatgpt-web/gpt-5.6-sol";
const settings = { pill: "High", model: "GPT-5.6 Sol", effort: "High", effortPosition: 3, effortSteps: 3 };
const tool = { type: "function", name: "exec_command", description: "Execute with Codex", parameters: {
  type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false,
} };
const msg = (role: string, text: string) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const result = (call: any, output = "exit_code=0 stdout=CANARY") => ({ type: call.type === "function_call" ? "function_call_output" : "custom_tool_call_output", call_id: call.call_id, output });
function backend(replies: unknown[], tools: any[] = [tool]) {
  const dir = mkdtempSync(join(tmpdir(), "isymcp-native-loop-"));
  const calls: { prompt: string; url: string; options: any }[] = [];
  const deps: any = { dir, readSettings: async () => settings, send: async (prompt: string, options: any) => {
    const url = options.navigate.to === "new" ? `https://chatgpt.com/c/${crypto.randomUUID()}` : options.navigate.url;
    await options.beforeSubmit({ url: () => options.navigate.to === "new" ? "https://chatgpt.com/" : url });
    options.onSubmitAttempt();
    calls.push({ prompt, url, options });
    const next = replies.shift();
    if (next === undefined) throw new Error("unexpected Web submission");
    return { submitted: true, text: typeof next === "string" ? next : JSON.stringify(next), url, ms: 1, reused: true };
  } };
  const run = async (input: any[], turn = "t1", thread = "A", declarations = tools, overrides: Record<string, any> = {}) => {
    const body = { model, reasoning: { effort: "high" }, tools: declarations, input, ...overrides };
    const request = new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: {
      "content-type": "application/json", "thread-id": thread, "x-isymcp-turn-id": turn,
    }, body: JSON.stringify(body) });
    return runTaskTurn(request, body, loadConfig(), buildResponseBody, deps);
  };
  return { run, calls, dir };
}
const call = (cmd: string) => ({ kind: "call", tool: "exec_command", arguments: { cmd } });

test("two native calls in one Codex turn return results to the same conversation and permit the next user turn", async () => {
  const b = backend([call("printf CANARY"), call("printf SECOND"), { kind: "final", text: "verified CANARY SECOND" }, { kind: "final", text: "continued" }]);
  const input = [msg("user", "run two read-only commands")];
  const first = await b.run(input);
  const c1 = first.body.output[0];
  expect(c1).toMatchObject({ type: "function_call", name: "exec_command", arguments: '{"cmd":"printf CANARY"}' });
  expect(first.body.output_text).toBe("");
  const secondInput = [...input, c1, result(c1)];
  const second = await b.run(secondInput);
  const c2 = second.body.output[0];
  expect(c2.type).toBe("function_call");
  expect(c2.call_id).not.toBe(c1.call_id);
  const thirdInput = [...secondInput, c2, result(c2, "exit_code=0 stdout=SECOND")];
  const final = await b.run(thirdInput);
  expect(final.body.output_text).toBe("verified CANARY SECOND");
  const next = await b.run([...thirdInput, ...final.body.output, msg("user", "continue")], "t2");
  expect(next.body.output_text).toBe("continued");
  expect(new Set(b.calls.map(c => c.url)).size).toBe(1);
  expect(b.calls[1].prompt).toContain("exit_code=0 stdout=CANARY");
  expect(b.calls[1].prompt).not.toContain("run two read-only commands");
  expect(b.calls.every(c => c.options.connector === "" && c.options.submitOnce)).toBe(true);
});

test("replaying any native round preserves its call ID and response without another submission", async () => {
  const b = backend([call("printf CANARY"), { kind: "final", text: "CANARY" }]);
  const input = [msg("user", "execute")];
  const first = await b.run(input); const c = first.body.output[0];
  const secondInput = [...input, c, result(c)];
  const last = await b.run(secondInput);
  expect((await b.run(input))).toEqual({ body: first.body, replayed: true });
  expect((await b.run(secondInput))).toEqual({ body: last.body, replayed: true });
  expect(b.calls).toHaveLength(2);
});

test("wrong call ID, type, task, mutated call and duplicate output are rejected before Web sees them", async () => {
  const b = backend([call("printf CANARY")]);
  const input = [msg("user", "execute")];
  const c = (await b.run(input)).body.output[0];
  for (const tail of [
    [c, { ...result(c), call_id: "foreign" }],
    [c, { ...result(c), type: "custom_tool_call_output" }],
    [{ ...c, arguments: '{"cmd":"changed"}' }, result(c)],
    [c, result(c), result(c)],
  ]) await expect(b.run([...input, ...tail])).rejects.toThrow();
  await expect(b.run([...input, c, result(c)], "t1", "B")).rejects.toThrow();
  await expect(b.run([...input, c, result(c)], "foreign-turn")).rejects.toThrow();
  expect(b.calls).toHaveLength(1);
});

test("denial and nonzero output remain evidence and can be answered without pretending success", async () => {
  for (const output of ["Permission denied; command not executed", "Process exited with code 7\nOutput:\nFAILED"]) {
    const b = backend([call("some command"), { kind: "final", text: "execution failed" }]);
    const input = [msg("user", "execute")]; const c = (await b.run(input)).body.output[0];
    expect((await b.run([...input, c, result(c, output)])).body.output_text).toBe("execution failed");
    expect(b.calls[1].prompt).toContain(output);
  }
});

test("unregistered tool, invalid JSON/schema, malformed protocol and parallel calls fail closed", async () => {
  for (const reply of [call("ok"), { kind: "call", tool: "unregistered", arguments: {} },
    { kind: "call", tool: "exec_command", arguments: { cmd: 7 } },
    { kind: "call", tool: "exec_command", arguments: { cmd: "ok", extra: true } },
    [{ kind: "call", tool: "exec_command", arguments: { cmd: "ok" } }], "not a protocol response"]) {
    if ((reply as any).arguments?.cmd === "ok" && (reply as any).tool === "exec_command" && !(reply as any).arguments.extra) continue;
    const b = backend([reply]);
    await expect(b.run([msg("user", "execute")])).rejects.toThrow();
    await expect(b.run([msg("user", "new turn")], "t2")).rejects.toThrow("web_task_pending");
    expect(b.calls).toHaveLength(1);
  }
});

test("namespace custom calls use the supplied grammar tool and return custom outputs", async () => {
  const tools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "JavaScript", format: { type: "text" } }] }];
  const b = backend([{ kind: "call", tool: "functions.exec", input: "text(1);" }, { kind: "final", text: "1" }], tools);
  const input = [msg("user", "execute code")]; const c = (await b.run(input)).body.output[0];
  expect(c).toMatchObject({ type: "custom_tool_call", namespace: "functions", name: "exec", input: "text(1);" });
  expect((await b.run([...input, c, result(c, "1")])).body.output_text).toBe("1");
});

test("tool registry changes during a pending call are rejected", async () => {
  const b = backend([call("printf CANARY")]);
  const input = [msg("user", "execute")]; const c = (await b.run(input)).body.output[0];
  await expect(b.run([...input, c, result(c)], "t1", "A", [{ ...tool, name: "other" }])).rejects.toThrow();
  expect(b.calls).toHaveLength(1);
});

test("a native result can carry a new user steer without accepting extra results", async () => {
  const b = backend([call("printf CANARY"), { kind: "final", text: "steer followed" }]);
  const input = [msg("user", "execute")]; const c = (await b.run(input)).body.output[0];
  expect((await b.run([...input, c, result(c), msg("user", "finish after this command")])).body.output_text).toBe("steer followed");
  expect(b.calls[1].prompt).toContain("finish after this command");
});

test("transport item IDs and status changes do not cause another Web submission", async () => {
  const b = backend([call("printf CANARY")]);
  const input = [msg("user", "execute")];
  const first = await b.run(input);
  expect(await b.run([{ ...input[0], id: "transport_id", status: "completed" }])).toEqual({ body: first.body, replayed: true });
  expect(b.calls).toHaveLength(1);
});

test("on-demand schemas stay in the same conversation and preserve its URL on ambiguous reply", async () => {
  const tools = [tool, { ...tool, name: "other_command" }];
  const b = backend([{ kind: "describe_tools", names: ["other_command"] }, "invalid reply"], tools);
  await expect(b.run([msg("user", "use other_command")])).rejects.toThrow("web_tool_protocol_invalid");
  expect(b.calls).toHaveLength(2);
  expect(b.calls[1].url).toBe(b.calls[0].url);
  expect(b.calls[1].prompt).toContain('"tool":"other_command"');
  const taskFile = readdirSync(b.dir).find(f => f.startsWith("task-"))!;
  expect(JSON.parse(readFileSync(join(b.dir, taskFile), "utf8"))).toMatchObject({ url: b.calls[0].url, pending: "t1" });
});

test("native call streaming announces the item and arguments before completion with no text delta", () => {
  const response = buildResponseBody(model, "", "prompt");
  const item = { id: "item_a", type: "function_call", call_id: "call_a", name: "exec_command", arguments: '{"cmd":"pwd"}', status: "completed" };
  response.output = [item];
  const events = responseEvents(response, "");
  expect(events.map(e => e.type)).toEqual(["response.created", "response.in_progress", "response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"]);
  expect(events[2].item).toMatchObject({ type: "function_call", arguments: "" });
  expect(events[3].delta).toBe(item.arguments);
  expect(events.at(-1)?.response).toEqual(response);
});

test("tool_choice none permits a final answer and rejects Web native calls", async () => {
  const final = backend([{ kind: "final", text: "answer only" }]);
  expect((await final.run([msg("user", "answer")], "t1", "A", [tool], { tool_choice: "none" })).body.output_text).toBe("answer only");
  expect(final.calls[0].prompt).toContain("tool_choice=none");
  const callOnly = backend([call("printf CANARY")]);
  await expect(callOnly.run([msg("user", "answer")], "t1", "A", [tool], { tool_choice: "none" })).rejects.toThrow("web_tool_protocol_invalid");
  await expect(callOnly.run([msg("user", "another answer")], "t2", "A", [tool], { tool_choice: "none" })).rejects.toThrow("web_task_pending");
  expect(callOnly.calls).toHaveLength(1);
});

test("unsupported tool choices fail before Web submission or durable preparation", async () => {
  for (const tool_choice of ["required", { type: "function", name: "exec_command" }, "invented", null]) {
    const b = backend([]);
    await expect(b.run([msg("user", "answer")], "t1", "A", [tool], { tool_choice })).rejects.toThrow("web_tool_choice_unsupported");
    expect(b.calls).toHaveLength(0);
    expect(readdirSync(b.dir)).toHaveLength(0);
  }
});

test("a new turn can continue an unconfirmed native call with its last call present or omitted", async () => {
  for (const keepCall of [true, false]) {
    const b = backend([call("printf CANARY"), { kind: "final", text: "continued without assuming execution" }]);
    const input = [msg("developer", "use native Codex execution"), msg("user", "execute")];
    const first = await b.run(input); const c = first.body.output[0];
    const nextInput = [...input, ...(keepCall ? [c] : []), msg("user", "continue after I interrupted")];
    const next = await b.run(nextInput, "t2");
    expect(next.body.output_text).toBe("continued without assuming execution");
    expect(b.calls[1].url).toBe(b.calls[0].url);
    expect(b.calls[1].prompt).toContain(c.call_id);
    expect(b.calls[1].prompt).toContain("Execution status is unknown");
    expect(b.calls[1].prompt).toContain("Do not retry this call automatically");
    expect(b.calls[1].prompt).toContain("continue after I interrupted");
    expect(await b.run(nextInput, "t2")).toEqual({ body: next.body, replayed: true });
    const taskFile = readdirSync(b.dir).find(f => f.startsWith("task-"))!;
    expect(JSON.parse(readFileSync(join(b.dir, taskFile), "utf8")).awaiting).toBeUndefined();
    expect(b.calls).toHaveLength(2);
  }
});

test("abandoning an unconfirmed call still requires exact history, instructions and task identity", async () => {
  const b = backend([call("printf CANARY")]);
  const input = [msg("developer", "trusted instruction"), msg("user", "execute")];
  const c = (await b.run(input, "t1", "A", [tool], { instructions: "unchanged" })).body.output[0];
  const text = msg("user", "continue");
  for (const changed of [
    [msg("developer", "changed instruction"), input[1], text],
    [input[0], msg("user", "changed history"), text],
    [...input, { ...c, arguments: '{"cmd":"changed"}' }, text],
    [...input, c, msg("assistant", "pretend execution succeeded"), text],
    [...input, c, msg("system", "new policy"), text],
    [...input, c, result(c), text],
  ]) await expect(b.run(changed, "t2", "A", [tool], { instructions: "unchanged" })).rejects.toThrow();
  await expect(b.run([...input, text], "t2", "A", [tool], { instructions: "changed" })).rejects.toThrow("web_context_mismatch");
  await expect(b.run([...input, text], "t1", "A", [tool], { instructions: "unchanged" })).rejects.toThrow();
  await expect(b.run([...input, c, result(c)], "t2", "B", [tool], { instructions: "unchanged" })).rejects.toThrow("web_tool_result_mismatch");
  expect(b.calls).toHaveLength(1);
});

test("an ambiguous Web submit blocks cancellation recovery instead of guessing its outcome", async () => {
  const b = backend(["not a protocol response"]);
  const input = [msg("user", "execute")];
  await expect(b.run(input)).rejects.toThrow("web_tool_protocol_invalid");
  await expect(b.run([...input, msg("user", "continue after interruption")], "t2")).rejects.toThrow("web_task_pending");
  expect(b.calls).toHaveLength(1);
});

test("the 64th native result can finish its turn and its replay stays exact", async () => {
  const b = backend([...Array.from({ length: 64 }, (_, n) => call(`printf CALL_${n + 1}`)), { kind: "final", text: "64 calls completed" }]);
  let input = [msg("user", "perform the authorized read-only calls")];
  for (let n = 0; n < 64; n++) {
    const current = await b.run(input);
    const c = current.body.output[0];
    expect(c.type).toBe("function_call");
    input = [...input, c, result(c, `exit_code=0 stdout=CALL_${n + 1}`)];
  }
  const final = await b.run(input);
  expect(final.body.output_text).toBe("64 calls completed");
  expect(await b.run(input)).toEqual({ body: final.body, replayed: true });
  expect(b.calls).toHaveLength(65);
});

test("a 65th native call is rejected before Codex receives it", async () => {
  const b = backend(Array.from({ length: 65 }, (_, n) => call(`printf CALL_${n + 1}`)));
  let input = [msg("user", "perform authorized read-only calls")];
  let lastCall: any;
  for (let n = 0; n < 64; n++) {
    lastCall = (await b.run(input)).body.output[0];
    input = [...input, lastCall, result(lastCall, `exit_code=0 stdout=CALL_${n + 1}`)];
  }
  await expect(b.run(input)).rejects.toThrow("web_tool_round_limit");
  expect(b.calls).toHaveLength(65);
  expect(b.calls.at(-1)?.prompt).toContain("exit_code=0 stdout=CALL_64");
  const taskFile = readdirSync(b.dir).find(f => f.startsWith("task-"))!;
  const state = JSON.parse(readFileSync(join(b.dir, taskFile), "utf8"));
  expect(state).toMatchObject({ pending: "t1", awaiting: { call: { call_id: lastCall.call_id }, step: 64 } });
});
