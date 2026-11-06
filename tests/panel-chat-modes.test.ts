import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChat, loadChat } from "../src/chats";
import { mintSession } from "../src/codex-sessions";
import { CHAT_SCRIPT, createSerializedDraftWriter, draftAfterSend, draftsToPersistOnPageHide, projectPanelActivity, projectPendingChatStatus, projectSavedReceipts, receiptLegacyLabel, renderChatView, restoreDraftState } from "../src/panel-chat";
import { handleChatApi } from "../src/panel";

let chatId: string;

beforeEach(() => {
  process.env.CODEX_WEB_HTTP_HOME = mkdtempSync(join(tmpdir(), "isymcp-panel-modes-"));
  chatId = createChat().id;
});

describe("panel chat modes", () => {
  test("serializes draft saves for one chat and lets later chats save independently", async () => {
    const writes: Array<{ id: string; draft: string; revision: number }> = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const writer = createSerializedDraftWriter(async (id, draft, revision) => {
      writes.push({ id, draft, revision });
      if (writes.length === 1) await first;
    });
    const oldWrite = writer("chat-a", "older", 10);
    const newWrite = writer("chat-a", "newer", 11);
    const otherChat = writer("chat-b", "independent", 4);
    await otherChat;
    expect(writes).toEqual([{ id: "chat-a", draft: "older", revision: 10 }, { id: "chat-b", draft: "independent", revision: 4 }]);
    releaseFirst();
    await Promise.all([oldWrite, newWrite]);
    expect(writes.at(-1)).toEqual({ id: "chat-a", draft: "newer", revision: 11 });
  });

  test("send clears an unchanged successful draft and preserves edits or failed text", () => {
    expect(draftAfterSend("sent", "", false, true)).toBe("");
    expect(draftAfterSend("sent", "sent", false, false)).toBe("sent");
    expect(draftAfterSend("sent", "new text", true, true)).toBe("new text");
    expect(draftAfterSend("sent", "new text", true, false)).toBe("new text");
    expect(CHAT_SCRIPT).toContain("draftAfterSend");
  });

  test("switching back restores tab selection and reload restores persisted text", () => {
    expect(restoreDraftState({ text: "hello world", start: 6, end: 11 }, "older server draft"))
      .toEqual({ text: "hello world", start: 6, end: 11 });
    expect(restoreDraftState(null, "reloaded draft"))
      .toEqual({ text: "reloaded draft", start: 14, end: 14 });
    expect(CHAT_SCRIPT).toContain("setSelectionRange(state.start,state.end)");
    expect(CHAT_SCRIPT).toContain("r.json.draft");
  });

  test("pagehide includes drafts left pending after switching chats", () => {
    expect(draftsToPersistOnPageHide("chat-b", { text: "draft in B", revision: 12 }, new Map([
      ["chat-a", { text: "pending draft in A", revision: 6 }],
      ["chat-b", { text: "stale draft in B", revision: 11 }],
    ]))).toEqual([
      ["chat-a", { text: "pending draft in A", revision: 6 }],
      ["chat-b", { text: "draft in B", revision: 12 }],
    ]);
    expect(CHAT_SCRIPT).toContain("draftsToPersistOnPageHide(chat.current,current,chat.dirtyDrafts)");
    expect(CHAT_SCRIPT).toContain("persistPagehideSnapshot(id,snapshot)");
    expect(CHAT_SCRIPT).toContain("revision:snapshot.revision");
    expect(CHAT_SCRIPT).not.toContain("flushDraft(id,draft,true)");
    expect(CHAT_SCRIPT).toContain("keepalive");
  });

  test("typing before a chat id stays tab-local and a draft save targets the private API", () => {
    expect(CHAT_SCRIPT).toContain("if(chat.current){chat.draftVersions");
    expect(CHAT_SCRIPT).toContain("saveDraftSoon(chat.current,state.text)");
    expect(CHAT_SCRIPT).toContain("/api/chats/'+encodeURIComponent(id)+'/draft");
    expect(CHAT_SCRIPT).toContain("/api/chats',{method:'POST'");
    expect(CHAT_SCRIPT).toContain("flushDraft(id,nextDraft)");
    expect(CHAT_SCRIPT).toContain("$('input').disabled=true;$('send').disabled=true;$('msgs').replaceChildren();renderEmpty()");
    expect(CHAT_SCRIPT).toContain("$('input').disabled=false;$('send').disabled=!!chat.pending");
    expect(CHAT_SCRIPT).not.toContain("fetch('/api/chats',{method:'POST'" );
    expect(() => new Function(CHAT_SCRIPT)).not.toThrow();
    expect(renderChatView()).toContain('maxlength="10000"');
  });

  test("renders three modes over one transcript and leaves Conversation selected by default", () => {
    const html = renderChatView();
    expect(html).toContain('data-view="conversation"');
    expect(html).toContain('data-view="evidence"');
    expect(html).toContain('data-view="activity"');
    expect(html).toContain('id="msgs"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('id="evidence-view"');
    expect(html).toContain('id="activity-view"');
    expect(CHAT_SCRIPT).toContain("readChatViewPreference");
  });

  test("evidence exposes persisted receipt filters, legacy state, and owning-message links", () => {
    const html = renderChatView();
    expect(html).toContain('id="evidence-filter"');
    expect(html).toContain("Todas");
    expect(html).toContain("Fallidas");
    expect(html).toContain("Completadas");
    expect(CHAT_SCRIPT).toContain("Comprobante heredado");
    expect(CHAT_SCRIPT).toContain("meta.tools");
    expect(CHAT_SCRIPT).toContain("dataset.messageIndex");
    expect(CHAT_SCRIPT).not.toContain("/api/trace");
  });

  test("empty and legacy evidence are represented honestly from saved messages", () => {
    expect(projectSavedReceipts([{ role: "assistant", text: "old message" }])).toEqual({ state: "none", receipts: [] });
    const result = projectSavedReceipts([{ role: "assistant", meta: { tools: [
      { tool: "codex_exec", summary: "git status", state: "ok" },
    ] } }]);
    expect(result.state).toBe("receipts");
    expect(result.receipts[0]?.card.correlation).toBe("legacy");
    expect(receiptLegacyLabel(result.receipts[0]!.card)).toBe("Comprobante heredado: la correlación exacta de esta llamada no está disponible.");
  });

  test("saved evidence filters failed and completed receipts without inventing fields", () => {
    const messages = [{ role: "assistant", meta: { tools: [
      { tool: "a", summary: "one", state: "failed", error: "exit 2", raw: "ignored" },
      { tool: "b", summary: "two", state: "ok", duration_ms: 12 },
      { tool: "c", summary: "three", state: "running" },
    ] } }];
    expect(projectSavedReceipts(messages, "failed").receipts.map((x) => x.card.tool)).toEqual(["a"]);
    expect(projectSavedReceipts(messages, "completed").receipts.map((x) => x.card.tool)).toEqual(["b"]);
    expect(projectSavedReceipts(messages, "failed").receipts[0]?.card).not.toHaveProperty("raw");
    expect(projectSavedReceipts(messages, "completed").receipts[0]?.card.duration_ms).toBe(12);
  });

  test("activity labels unavailable bridge and avoids assigning another chat phase", () => {
    const html = renderChatView();
    expect(html).toContain('id="activity-bridge"');
    expect(CHAT_SCRIPT).toContain("Bridge no disponible");
    expect(CHAT_SCRIPT).toContain("Otro chat activo");
    expect(CHAT_SCRIPT).toContain("/api/chat/status");
    expect(projectPanelActivity(null, chatId, true)).toEqual({ bridge: "unavailable", relation: "unknown" });
    const other = projectPanelActivity({ chat_id: "c_other", phase: "thinking", queued: 2, tools: [
      { tool: "secret_context", summary: "belongs to another chat", state: "running" },
    ] }, chatId);
    expect(other).toEqual({ bridge: "available", relation: "other" });
    expect(other).not.toHaveProperty("phase");
    expect(other).not.toHaveProperty("tools");
    const mine = projectPanelActivity({ chat_id: chatId, phase: "thinking", since: "2026-10-15T12:00:00Z", queued: 1, tools: [
      { tool: "codex_exec", summary: "git status", state: "running", trace_id: "private" },
    ] }, chatId);
    expect(mine.relation).toBe("selected");
    expect(mine.phase).toBe("thinking");
    expect(mine.tools?.[0]?.tool).toBe("codex_exec");
    expect(mine.tools?.[0]).not.toHaveProperty("trace_id");
    expect(projectPanelActivity({ phase: "queued", chat_id: null, queued: 1 }, chatId).relation).toBe("queued_unattributed");
  });

  test("pending assistant updates accept status content only from the selected chat", () => {
    const foreign = projectPendingChatStatus({
      chat_id: "c_other", phase: "thinking", thought: "foreign thought", partial: "foreign partial",
      tools: [{ tool: "secret", summary: "foreign tool", state: "running" }],
    }, chatId);
    expect(foreign).toEqual({ matchesChat: false });

    const selected = projectPendingChatStatus({
      chat_id: chatId, phase: "thinking", thought: "selected thought", partial: "selected partial",
      tools: [{ tool: "safe_tool", summary: "selected summary", state: "running", trace_id: "private" }],
    }, chatId);
    expect(selected.matchesChat).toBe(true);
    expect(selected).toMatchObject({ phase: "thinking", thought: "selected thought", partial: "selected partial" });
    expect(selected.tools?.[0]).toMatchObject({ tool: "safe_tool", summary: "selected summary" });
    expect(selected.tools?.[0]).not.toHaveProperty("trace_id");
    expect(CHAT_SCRIPT).toContain("projectPendingChatStatus");
  });

  test("one status poller switches between fast pending and slow visible-idle cadence", () => {
    expect(CHAT_SCRIPT).toContain("current:null,data:null,draft:'',sessions:[],settings:");
    expect((CHAT_SCRIPT.match(/api\('\/api\/chat\/status'\)/g) ?? [])).toHaveLength(1);
    expect(CHAT_SCRIPT).toContain("chat.pending?600:10000");
    expect(CHAT_SCRIPT).toContain("chat.statusInFlight");
    expect(CHAT_SCRIPT).toContain("statusPollVisible");
    expect(CHAT_SCRIPT).toContain("clearTimeout(chat.statusTimer)");
  });

  test("choosing a valid session while tools are off persists it without enabling tools", async () => {
    const session = mintSession(tmpdir(), { label: "panel-test" });
    const request = new Request(`http://127.0.0.1/api/chats/${chatId}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools_enabled: false, session_fp: session.fp }),
    });

    const response = await handleChatApi(request, new URL(request.url), "59999");

    expect(response.status).toBe(200);
    expect(loadChat(chatId)).toMatchObject({ tools_enabled: false, session_fp: session.fp });
  });

  test("rejects an unknown selected session while tools are off", async () => {
    const request = new Request(`http://127.0.0.1/api/chats/${chatId}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools_enabled: false, session_fp: "not-a-session" }),
    });

    const response = await handleChatApi(request, new URL(request.url), "59999");

    expect(response.status).toBe(400);
    expect(loadChat(chatId)).toMatchObject({ tools_enabled: false, session_fp: null });
  });
});
