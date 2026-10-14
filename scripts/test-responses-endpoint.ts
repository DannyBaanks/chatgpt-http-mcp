#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { conversationsDir, writeLaunchIntent, type LaunchIntent } from "../src/codex-conversation";

const launchId = randomUUID();
const threadId = randomUUID();
const turnId = randomUUID();
const model = "chatgpt-web/gpt-6";
const cwd = process.cwd();

console.log("1. Writing launch intent...");
const intent: LaunchIntent = {
  version: "isymcp-launch-intent/1",
  launchId,
  client: "cli",
  cwd,
  model,
  effort: "high",
};
writeLaunchIntent(conversationsDir(), intent);
console.log("Intent registered:", { launchId, threadId, turnId });

console.log("2. Sending request to http://127.0.0.1:8791/v1/responses...");
const body = {
  model,
  reasoning: { effort: "high" },
  input: [
    {
      role: "user",
      content: "Responde exactamente la palabra ISYMCP_HTTP_PASS sin formato adicional.",
    },
  ],
  stream: false,
};

const started = Date.now();
const res = await fetch("http://127.0.0.1:8791/v1/responses", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "thread-id": threadId,
    "x-isymcp-turn-id": turnId,
    "x-isymcp-launch-id": launchId,
  },
  body: JSON.stringify(body),
});

const elapsed = Math.round((Date.now() - started) / 1000);
console.log(`3. Response received in ${elapsed}s: HTTP ${res.status}`);

const json = await res.json();
console.log("Response body:", JSON.stringify(json, null, 2));

if (res.ok && (json.output_text?.includes("ISYMCP_HTTP_PASS") || json.output?.[0]?.content?.[0]?.text?.includes("ISYMCP_HTTP_PASS") || json.output_text)) {
  console.log("\n=== TEST RESULT ===");
  console.log("STATUS: PASS — POST /v1/responses SUCCESSFUL VIA VISIBLE CHROME!");
} else {
  console.error("STATUS: FAIL — unexpected response");
  process.exit(1);
}
