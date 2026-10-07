#!/usr/bin/env bun
// Controlled real text canary. Private state stays in a fresh temporary directory.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";
import { closeWebSession } from "../src/web-turn";

const config = { ...loadConfig(), port: 0, webModels: "on" as const, webTurnDeadlineMs: 120_000 };
const privateDir = mkdtempSync(join(tmpdir(), "isymcp-m8-live-"));
process.env.CODEX_WEB_HTTP_HOME = privateDir;
const server = startServer(config);
const base = `http://127.0.0.1:${server.port}`;
const model = "chatgpt-web/gpt-5.6-sol";
const msg = (role: string, text: string) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const rows: any[] = [];
async function request(task: string, turn: string, input: unknown) {
  const started = Date.now();
  const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "thread-id": task, "x-isymcp-turn-id": turn },
    body: JSON.stringify({ model, reasoning: { effort: "high" }, input }), signal: AbortSignal.timeout(180_000) });
  const body = await response.json();
  rows.push({ task, turn, status: response.status, ms: Date.now() - started, replayed: response.headers.get("x-isymcp-replayed"), body });
  console.log(JSON.stringify(rows.at(-1)));
  if (!response.ok) throw new Error(body.error?.type ?? "request_failed");
  return body;
}
try {
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  const nonceA = "ALPHA_" + crypto.randomUUID().slice(0, 8), nonceB = "BRAVO_" + crypto.randomUUID().slice(0, 8);
  const inputA = [msg("user", `Remember the word ${nonceA} for this conversation. Reply exactly ACK.`)];
  const inputB = [msg("user", `Remember the word ${nonceB} for this conversation. Reply exactly ACK.`)];
  const firstA = await request(a, "a1", inputA);
  const firstB = await request(b, "b1", inputB);
  if (firstA.output_text.trim() !== "ACK" || firstB.output_text.trim() !== "ACK") throw new Error("first_echo_mismatch");
  const recall = "What word did I ask you to remember? Reply with only that exact word.";
  const againA = await request(a, "a2", [...inputA, msg("assistant", firstA.output_text), msg("user", recall)]);
  const againB = await request(b, "b2", [...inputB, msg("assistant", firstB.output_text), msg("user", recall)]);
  if (againA.output_text.trim() !== nonceA || againB.output_text.trim() !== nonceB) throw new Error("task_contamination");
  if (firstA.metadata.isymcp_conversation === firstB.metadata.isymcp_conversation || againA.metadata.isymcp_conversation !== firstA.metadata.isymcp_conversation || againB.metadata.isymcp_conversation !== firstB.metadata.isymcp_conversation) throw new Error("conversation_identity_mismatch");
  const replay = await request(a, "a1", inputA);
  if (JSON.stringify(replay) !== JSON.stringify(firstA) || rows.at(-1).replayed !== "1") throw new Error("replay_mismatch");
  console.log(JSON.stringify({ result: "PASS", scope: "real HTTP A/B/A/B + durable replay; visible Sol High verified before submission", privateDir }));
} catch (error) {
  console.error(JSON.stringify({ result: "FAIL", error: error instanceof Error ? error.message : String(error), privateDir }));
  process.exitCode = 1;
} finally {
  writeFileSync(join(privateDir, "canary.json"), JSON.stringify(rows, null, 2), { mode: 0o600 });
  server.stop(true);
  await closeWebSession();
}
