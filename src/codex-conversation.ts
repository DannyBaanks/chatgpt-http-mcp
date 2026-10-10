// codex-conversation.ts — entrada guiada de una conversación Codex nueva.
// El CLI lleva un proveedor por proceso. La App no tiene una entrada
// verificada y se rechaza. El recibo solo se confirma con un turno ya
// comprometido; un replay reconstruye ese mismo recibo y no otra conversación.
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { bridgeHome } from "./codex-sessions";
import { buildIsolatedCodexArgs } from "../scripts/install-web-models";
import { VERIFIED_WEB_ROUTES } from "./web-models";
import { canonicalConversationUrl } from "./web-turn";

export const LAUNCH_HEADER = "x-isymcp-launch-id";
export const LAUNCH_ENV = "ISYMCP_LAUNCH_ID";
const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LaunchIntent {
  version: "isymcp-launch-intent/1";
  launchId: string;
  client: "cli";
  cwd: string;
  model: string;
  effort: "high";
}

export interface ConversationReceipt extends LaunchIntent {
  version: "isymcp-conversation/1";
  threadId: string;
  url: string;
  taskKey: string;
  state: "committed";
}

export function conversationsDir(dir?: string): string {
  return dir ?? join(bridgeHome(), "codex-responses");
}

export function rejectAppClient(client: string): "cli" {
  if (client === "app") {
    throw new Error("web_app_entry_unavailable: Codex App has no verified per-thread custom-provider entry; a daemon is not the desktop");
  }
  if (client !== "cli") throw new Error("web_conversation_client_invalid: expected cli or app");
  return "cli";
}

function assertModel(model: string): string {
  if (!VERIFIED_WEB_ROUTES[model]?.includes("high")) throw new Error(`web_conversation_model_unverified: ${model}`);
  return model;
}

function assertCwd(cwd: string): string {
  if (!isAbsolute(cwd)) throw new Error("web_conversation_cwd_invalid: workspace must be an absolute path");
  return cwd;
}

function assertLaunchId(launchId: string): string {
  if (!LAUNCH_ID.test(launchId)) throw new Error("web_conversation_launch_invalid: launch id is not a UUID");
  return launchId;
}

export function planNewConversation(input: { client: string; cwd: string; model?: string; launchId?: string }): {
  intent: LaunchIntent;
  env: Record<string, string>;
  args: (options: { port: string; catalogPath?: string }) => string[];
} {
  const client = rejectAppClient(input.client);
  const model = assertModel(input.model ?? "chatgpt-web/gpt-5.6-sol");
  const cwd = assertCwd(input.cwd);
  const launchId = assertLaunchId(input.launchId ?? randomUUID());
  const intent: LaunchIntent = { version: "isymcp-launch-intent/1", launchId, client, cwd, model, effort: "high" };
  return {
    intent,
    env: { [LAUNCH_ENV]: launchId },
    args: ({ port, catalogPath }) => conversationArgs({ port, catalogPath, model, cwd, launchId }),
  };
}

export function planResumeConversation(receipt: ConversationReceipt, options: { port: string; catalogPath?: string }): string[] {
  if (receipt.state !== "committed" || receipt.client !== "cli") throw new Error("web_conversation_resume_invalid: only a committed CLI receipt can resume");
  const launch = conversationArgs({
    port: options.port, catalogPath: options.catalogPath, model: receipt.model, cwd: receipt.cwd, launchId: receipt.launchId,
  });
  // Interactive resume of the saved thread. The id is positional and exact.
  return ["resume", ...launch, receipt.threadId];
}

function conversationArgs(input: { port: string; catalogPath?: string; model: string; cwd: string; launchId: string }): string[] {
  if (!/^\d+$/.test(input.port) || Number(input.port) < 1 || Number(input.port) > 65535) throw new Error("puerto del bridge invalido");
  const provider = buildIsolatedCodexArgs(
    `http://127.0.0.1:${input.port}/v1`, input.model, "high", input.catalogPath, undefined,
    { [LAUNCH_HEADER]: LAUNCH_ENV },
  );
  const args = ["--no-daemon", ...provider, "-C", input.cwd];
  const flat = args.join("\n");
  if (args.includes("--last") || args.includes("exec") || !flat.includes(LAUNCH_HEADER) || !flat.includes(LAUNCH_ENV)) {
    throw new Error("web_conversation_plan_invalid: launch plan drifted");
  }
  assertLaunchId(input.launchId);
  return args;
}

function intentPath(dir: string, launchId: string): string {
  return join(dir, `intent-${assertLaunchId(launchId)}.json`);
}

function receiptPath(dir: string, launchId: string): string {
  return join(dir, `conversation-${assertLaunchId(launchId)}.json`);
}

function privateWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeLaunchIntent(dir: string, intent: LaunchIntent): void {
  assertLaunchId(intent.launchId);
  if (intent.version !== "isymcp-launch-intent/1" || intent.client !== "cli" || intent.effort !== "high") {
    throw new Error("web_conversation_launch_invalid: intent is not a CLI high launch");
  }
  assertModel(intent.model);
  assertCwd(intent.cwd);
  const path = intentPath(dir, intent.launchId);
  if (existsSync(path) && JSON.stringify(readJson(path)) !== JSON.stringify(intent)) {
    throw new Error("web_conversation_launch_conflict: launch intent already has different content");
  }
  if (!existsSync(path)) privateWrite(path, intent);
}

export function commitConversationReceipt(dir: string, facts: {
  launchId: string; threadId: string; taskKey: string; url: string; model: string; effort: "high";
}): ConversationReceipt {
  const launchId = assertLaunchId(facts.launchId);
  const intentPathname = intentPath(dir, launchId);
  if (!existsSync(intentPathname)) throw new Error("web_launch_intent_missing: committed turn has no launch intent");
  const intent = readJson(intentPathname) as LaunchIntent;
  const url = canonicalConversationUrl(facts.url);
  if (!url) throw new Error("web_conversation_url_invalid: committed turn has no canonical conversation");
  if (intent.launchId !== launchId || intent.model !== facts.model || intent.effort !== facts.effort || intent.client !== "cli") {
    throw new Error("web_conversation_receipt_conflict: launch intent does not match the committed turn");
  }
  if (!facts.threadId.trim() || facts.threadId.length > 256 || !/^[0-9a-f]{64}$/.test(facts.taskKey)) {
    throw new Error("web_conversation_receipt_invalid: thread or task key is not exact");
  }
  const receipt: ConversationReceipt = {
    version: "isymcp-conversation/1", launchId, client: "cli", cwd: intent.cwd, model: intent.model,
    effort: "high", threadId: facts.threadId, url, taskKey: facts.taskKey, state: "committed",
  };
  const path = receiptPath(dir, launchId);
  if (existsSync(path)) {
    const existing = JSON.stringify(readJson(path));
    if (existing !== JSON.stringify(receipt)) throw new Error("web_conversation_receipt_conflict: replay does not match the saved receipt");
    return receipt;
  }
  privateWrite(path, receipt);
  return receipt;
}

export function listConversations(dir = conversationsDir()): ConversationReceipt[] {
  if (!existsSync(dir)) return [];
  const out: ConversationReceipt[] = [];
  for (const name of readdirSync(dir)) {
    const match = /^conversation-([0-9a-f-]{36})\.json$/i.exec(name);
    if (!match) continue;
    const receipt = readJson(join(dir, name)) as ConversationReceipt;
    if (receipt.launchId !== match[1] || receipt.state !== "committed" || !receipt.threadId) {
      throw new Error(`web_conversation_receipt_invalid: ${name}`);
    }
    out.push(receipt);
  }
  return out.sort((a, b) => a.launchId.localeCompare(b.launchId));
}

export function findConversation(dir: string, id: string): ConversationReceipt {
  const matches = listConversations(dir).filter((receipt) => receipt.launchId === id || receipt.threadId === id);
  if (matches.length !== 1) throw new Error("web_conversation_resume_ambiguous: resume needs one exact launch id or thread id");
  return matches[0]!;
}

export function receiptDigest(receipt: ConversationReceipt): string {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}
