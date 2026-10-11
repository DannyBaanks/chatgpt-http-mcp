import { expect, test } from "bun:test";
import {
  NativeWriterLease,
  correlateNativeToolResult,
  requireBoundBrowserSource,
} from "../src/visible/host";

test("rejects a competing writer without releasing the current owner", async () => {
  const lease = new NativeWriterLease();
  const first = await lease.acquire("thread-a", "writer-one");
  await expect(lease.acquire("thread-a", "writer-two")).rejects.toThrow("native_writer_conflict");
  expect(await lease.owner("thread-a")).toBe("writer-one");
  await lease.release("thread-a", "writer-two");
  expect(await lease.owner("thread-a")).toBe("writer-one");
  await lease.release("thread-a", first);
  expect(await lease.owner("thread-a")).toBeUndefined();
});

test("accepts only the actual native result correlated to the declared call", () => {
  const call = {
    type: "function_call",
    name: "exec_command",
    call_id: "call_canary_1",
    arguments: JSON.stringify({ cmd: "printf ISYMCP_NATIVE_CANARY" }),
  };
  const result = {
    type: "function_call_output",
    call_id: "call_canary_1",
    output: "ISYMCP_NATIVE_CANARY",
  };
  expect(correlateNativeToolResult(call, result)).toEqual({
    callId: "call_canary_1",
    wireName: "exec_command",
    output: "ISYMCP_NATIVE_CANARY",
  });
  expect(() => correlateNativeToolResult(call, { ...result, call_id: "foreign_call" }))
    .toThrow("native_tool_result_mismatch");
  expect(() => correlateNativeToolResult(call, { ...result, type: "message" }))
    .toThrow("native_tool_result_mismatch");
});

test("missing browser source identity requires an explicit binding", () => {
  expect(() => requireBoundBrowserSource({})).toThrow("browser_source_binding_required");
  expect(requireBoundBrowserSource({
    url: "https://chatgpt.com/c/test-conversation",
    messageId: "msg-1",
  })).toEqual({
    url: "https://chatgpt.com/c/test-conversation",
    messageId: "msg-1",
  });
});
