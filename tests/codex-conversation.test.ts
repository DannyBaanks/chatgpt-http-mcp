import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  commitConversationReceipt, findConversation, listConversations, planNewConversation, planResumeConversation,
  rejectAppClient, writeLaunchIntent, type ConversationReceipt,
} from "../src/codex-conversation";

const model = "chatgpt-web/gpt-5.6-sol";
const launchA = "11111111-1111-4111-8111-111111111111";
const launchB = "22222222-2222-4222-8222-222222222222";
const taskKey = "a".repeat(64);

test("the desktop app is refused before a provider or a new conversation exists", () => {
  expect(() => rejectAppClient("app")).toThrow("web_app_entry_unavailable");
  expect(() => planNewConversation({ client: "app", cwd: "/tmp/workspace" })).toThrow("web_app_entry_unavailable");
});

test("a CLI launch is per-process, interactive, and carries the launch header", () => {
  const plan = planNewConversation({ client: "cli", cwd: "/tmp/workspace-a", model, launchId: launchA });
  const args = plan.args({ port: "8791", catalogPath: "/tmp/catalog.json" });
  expect(plan.env).toEqual({ ISYMCP_LAUNCH_ID: launchA });
  expect(args[0]).toBe("--no-daemon");
  expect(args).toContain("-C");
  expect(args).toContain("/tmp/workspace-a");
  expect(args.join("\n")).toContain('model="chatgpt-web/gpt-5.6-sol"');
  expect(args.join("\n")).toContain('"x-isymcp-launch-id"="ISYMCP_LAUNCH_ID"');
  expect(args).not.toContain("--last");
  expect(args).not.toContain("exec");
  expect(args.join("\n")).not.toContain("openai_base_url");
});

test("two committed chats resume by exact thread id and replay the same receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "isymcp-conversations-"));
  try {
    const first = planNewConversation({ client: "cli", cwd: "/tmp/workspace-a", model, launchId: launchA });
    const second = planNewConversation({ client: "cli", cwd: "/tmp/workspace-b", model: "chatgpt-web/gpt-6", launchId: launchB });
    writeLaunchIntent(dir, first.intent);
    writeLaunchIntent(dir, second.intent);
    const alpha = commitConversationReceipt(dir, {
      launchId: launchA, threadId: "thread-alpha", taskKey, url: "https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", model, effort: "high",
    });
    const bravo = commitConversationReceipt(dir, {
      launchId: launchB, threadId: "thread-bravo", taskKey: "b".repeat(64), url: "https://chatgpt.com/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      model: "chatgpt-web/gpt-6", effort: "high",
    });
    expect(alpha.url).not.toBe(bravo.url);
    expect(listConversations(dir).map((row) => row.threadId)).toEqual(["thread-alpha", "thread-bravo"]);
    expect(findConversation(dir, "thread-bravo").launchId).toBe(launchB);
    const resume = planResumeConversation(bravo, { port: "8791" });
    expect(resume[0]).toBe("resume");
    expect(resume.at(-1)).toBe("thread-bravo");
    expect(resume).toContain("--no-daemon");
    expect(resume).toContain("/tmp/workspace-b");
    expect(resume.join("\n")).toContain('model="chatgpt-web/gpt-6"');
    expect(resume).not.toContain("--last");
    expect(resume).not.toContain("exec");
    expect(statSync(join(dir, `conversation-${launchA}.json`)).mode & 0o777).toBe(0o600);
    const replay = commitConversationReceipt(dir, {
      launchId: launchA, threadId: alpha.threadId, taskKey, url: alpha.url, model, effort: "high",
    });
    expect(replay).toEqual(alpha satisfies ConversationReceipt);
    expect(() => commitConversationReceipt(dir, {
      launchId: launchA, threadId: "thread-other", taskKey, url: alpha.url, model, effort: "high",
    })).toThrow("web_conversation_receipt_conflict");
  } finally { rmSync(dir, { recursive: true }); }
});
