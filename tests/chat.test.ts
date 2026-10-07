// chat.test.ts — Fase 1 del chat local: T1-T12 de la spec.
//
// ChatGPT se simula con FakeChatGPT: una pestana unica (como la real) con
// conversaciones /c/ independientes. Ejecuta la navegacion que pide el turno y
// recuerda los prompts por conversacion, asi que puede responder "que te dije
// primero" y demostrar continuidad/aislamiento sin red.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { chatPath, chatsDir, createChat, listChats, loadChat, publicChat } from "../src/chats";
import { chatStatus, isProviderBlock, runChatTurn } from "../src/chat-turn";
import { canonicalConversationUrl, navigationTarget, type WebTurnOptions, type WebTurnResult } from "../src/web-turn";
import { defaultNavigation } from "../src/sessions";
import { chatBodyToWebRequest } from "../src/chat-completions";
import { handleChatApi } from "../src/panel";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "isymcp-chat-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
});
afterAll(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(home, { recursive: true, force: true });
});

const config = loadConfig({});

class FakeChatGPT {
  url = "https://chatgpt.com/";
  convs = new Map<string, string[]>();
  prompts: string[] = [];
  navigations: string[] = [];
  active = 0;
  maxActive = 0;
  delayMs = 0;
  /** Respuestas forzadas (FIFO) para simular bloqueos o fallos. */
  scripted: Array<Partial<WebTurnResult> | Error> = [];
  /** Global entre instancias: como en ChatGPT real, dos conversaciones nunca
   * comparten id (si no, la deteccion de choques las rechaza, con razon). */
  static n = 0;

  send = async (prompt: string, options: WebTurnOptions): Promise<WebTurnResult> => {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const target = navigationTarget(this.url, options.navigate);
      if (target) {
        options.onPhase?.("navigating");
        this.navigations.push(target);
        this.url = target;
      }
      options.onPhase?.("thinking");
      if (this.delayMs) await Bun.sleep(this.delayMs);
      this.prompts.push(prompt);
      const forced = this.scripted.shift();
      if (forced instanceof Error) throw forced;
      // Primer mensaje en la home: ChatGPT asigna /c/ al enviar.
      if (!canonicalConversationUrl(this.url)) {
        this.url = `https://chatgpt.com/c/0000${(++FakeChatGPT.n).toString(16).padStart(4, "0")}-aaaa-bbbb-cccc-dddddddddddd`;
        this.convs.set(this.url, []);
      }
      const history = this.convs.get(this.url)!;
      history.push(prompt);
      const text = prompt.startsWith("RECALL") ? `primero: ${history[0]}` : `eco: ${prompt}`;
      return { text, ms: 1, submitted: true, reused: true, url: this.url, ...(forced ?? {}) };
    } finally {
      this.active--;
    }
  };
}

describe("registro de chats", () => {
  test("T8 chat_id arbitrario no escapa del registro", async () => {
    for (const bad of ["../codex-sessions", "c_../../x", "c_ZZZZ", "", "c_0123456789abcdef/../../x"]) {
      expect(chatPath(bad)).toBeNull();
      expect(loadChat(bad)).toBeNull();
    }
    await expect(runChatTurn("../codex-sessions", "hola", config, { send: new FakeChatGPT().send })).rejects.toMatchObject({ status: 400 });
    const res = await handleChatApi(new Request("http://127.0.0.1/api/chats/..%2Fcodex-sessions"), new URL("http://127.0.0.1/api/chats/..%2Fcodex-sessions"), "1");
    expect(res.status).toBe(400);
  });

  test("T12 recarga: el listado se reconstruye del disco, privado y sin secretos", () => {
    const chat = createChat();
    expect(statSync(chatsDir()).mode & 0o777).toBe(0o700);
    expect(statSync(chatPath(chat.id)!).mode & 0o777).toBe(0o600);
    const listed = listChats().map((c) => publicChat(c, true));
    expect(listed.some((c) => c.id === chat.id)).toBe(true);
    const wire = JSON.stringify(listed);
    for (const secret of ["token", "cookie", "storage", "turn_token", "Bearer"]) expect(wire).not.toContain(secret);
    expect(publicChat(chat, false).tools_enabled).toBe(false);
  });
});

describe("turnos de chat (FakeChatGPT)", () => {
  test("T1/T2 cada chat nuevo crea su propia conversacion remota y se persiste", async () => {
    const gpt = new FakeChatGPT();
    const a = createChat();
    const b = createChat();
    const ra = await runChatTurn(a.id, "hola A", config, { send: gpt.send });
    const rb = await runChatTurn(b.id, "hola B", config, { send: gpt.send });
    expect(ra.ok && rb.ok).toBe(true);
    const ua = loadChat(a.id)!.conversation_url;
    const ub = loadChat(b.id)!.conversation_url;
    expect(canonicalConversationUrl(ua)).toBe(ua);
    expect(canonicalConversationUrl(ub)).toBe(ub);
    expect(ua).not.toBe(ub);
    // El primer turno de cada chat navego a una conversacion NUEVA.
    expect(gpt.navigations.filter((n) => n === "https://chatgpt.com/").length).toBeGreaterThanOrEqual(1);
    expect(loadChat(a.id)!.title).toBe("hola A");
  });

  test("T3 A -> B -> A conserva el contexto remoto de cada uno", async () => {
    const gpt = new FakeChatGPT();
    const a = createChat();
    const b = createChat();
    await runChatTurn(a.id, "palabra-A", config, { send: gpt.send });
    await runChatTurn(b.id, "palabra-B", config, { send: gpt.send });
    const backA = await runChatTurn(a.id, "RECALL", config, { send: gpt.send });
    const backB = await runChatTurn(b.id, "RECALL", config, { send: gpt.send });
    expect(backA.reply.text).toBe("primero: palabra-A");
    expect(backB.reply.text).toBe("primero: palabra-B");
    expect(gpt.navigations).toContain(loadChat(a.id)!.conversation_url!);
  });

  test("T4 solo se envia el mensaje nuevo (sin transcript)", async () => {
    const gpt = new FakeChatGPT();
    const chat = createChat();
    await runChatTurn(chat.id, "uno", config, { send: gpt.send });
    await runChatTurn(chat.id, "  dos  ", config, { send: gpt.send });
    expect(gpt.prompts).toEqual(["uno", "dos"]);
  });

  test("T9 cambiar de chat no puede tocar la pestana durante un turno activo", async () => {
    const gpt = new FakeChatGPT();
    gpt.delayMs = 60;
    const a = createChat();
    const b = createChat();
    await runChatTurn(a.id, "a0", config, { send: gpt.send });
    await runChatTurn(b.id, "b0", config, { send: gpt.send });
    gpt.navigations = [];
    const order: string[] = [];
    const ta = runChatTurn(a.id, "a1", config, { send: async (p, o) => { order.push("A:start"); const r = await gpt.send(p, o); order.push("A:end"); return r; } });
    await Bun.sleep(5);
    expect(chatStatus().chat_id).toBe(a.id);
    const tb = runChatTurn(b.id, "b1", config, { send: async (p, o) => { order.push("B:start"); const r = await gpt.send(p, o); order.push("B:end"); return r; } });
    await Bun.sleep(5);
    expect(chatStatus().queued).toBe(1);
    const [ra, rb] = await Promise.all([ta, tb]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
    expect(gpt.maxActive).toBe(1);
    expect(ra.reply.meta?.url).toBe(loadChat(a.id)!.conversation_url);
    expect(rb.reply.meta?.url).toBe(loadChat(b.id)!.conversation_url);
    expect(chatStatus()).toMatchObject({ phase: "idle", queued: 0 });
  });

  test("T10 bloqueo de OpenAI se clasifica como provider y el siguiente turno funciona", async () => {
    const gpt = new FakeChatGPT();
    const chat = createChat();
    await runChatTurn(chat.id, "hola", config, { send: gpt.send });
    gpt.scripted.push({ text: "Esta llamada a la herramienta se ha bloqueado por los controles de seguridad de OpenAI." });
    const blocked = await runChatTurn(chat.id, "algo", config, { send: gpt.send });
    expect(blocked.ok).toBe(false);
    expect(blocked.reply.role).toBe("error");
    expect(blocked.reply.meta?.kind).toBe("provider_blocked");
    const next = await runChatTurn(chat.id, "otra", config, { send: gpt.send });
    expect(next.ok).toBe(true);
    expect(next.reply.text).toBe("eco: otra");
  });

  test("fallo del bridge se clasifica distinto al bloqueo del provider", async () => {
    const gpt = new FakeChatGPT();
    const chat = createChat();
    gpt.scripted.push(new Error("web_session_expired: ChatGPT no aparece logueado"));
    const r1 = await runChatTurn(chat.id, "hola", config, { send: gpt.send });
    expect(r1.reply.meta?.kind).toBe("session");
    gpt.scripted.push(new Error("web_page_crashed: boom"));
    const r2 = await runChatTurn(chat.id, "hola", config, { send: gpt.send });
    expect(r2.reply.meta?.kind).toBe("browser");
    gpt.scripted.push(new Error("algo raro"));
    const r3 = await runChatTurn(chat.id, "hola", config, { send: gpt.send });
    expect(r3.reply.meta?.kind).toBe("bridge");
    expect(isProviderBlock("Error: algo raro")).toBe(false);
  });

  test("captura canonica: sin /c/ o /c/ ajena no se persiste", async () => {
    const gpt = new FakeChatGPT();
    const chat = createChat();
    gpt.scripted.push({ url: "https://chatgpt.com/" });
    const noC = await runChatTurn(chat.id, "hola", config, { send: gpt.send });
    expect(noC.reply.meta?.kind).toBe("capture");
    expect(loadChat(chat.id)!.conversation_url).toBeNull();

    const owner = createChat();
    await runChatTurn(owner.id, "mio", config, { send: gpt.send });
    const taken = loadChat(owner.id)!.conversation_url!;
    const thief = createChat();
    gpt.scripted.push({ url: taken });
    const clash = await runChatTurn(thief.id, "hola", config, { send: gpt.send });
    expect(clash.reply.meta?.kind).toBe("capture");
    expect(loadChat(thief.id)!.conversation_url).toBeNull();

    gpt.scripted.push({ url: "https://chatgpt.com/c/ffff0000-aaaa-bbbb-cccc-dddddddddddd" });
    const drift = await runChatTurn(owner.id, "otra", config, { send: gpt.send });
    expect(drift.reply.meta?.kind).toBe("capture");
    expect(loadChat(owner.id)!.conversation_url).toBe(taken);
  });
});

describe("texto en vivo", () => {
  test("el estado expone la respuesta parcial del chat activo y la limpia al terminar", async () => {
    const chat = createChat();
    const seen: Array<string | undefined> = [];
    const send = async (prompt: string, options: WebTurnOptions): Promise<WebTurnResult> => {
      options.onPhase?.("thinking");
      for (const partial of ["Ho", "Hola, ", "Hola, mundo"]) {
        options.onProgress?.(partial);
        seen.push(chatStatus().partial);
        await Bun.sleep(5);
      }
      return { text: "Hola, mundo", markdown: "**Hola**, mundo", ms: 1, submitted: true, reused: true, url: "https://chatgpt.com/c/5eed0000-aaaa-bbbb-cccc-dddddddddddd" };
    };
    const out = await runChatTurn(chat.id, "hola", config, { send });
    expect(seen).toEqual(["Ho", "Hola, ", "Hola, mundo"]);
    expect(chatStatus().partial).toBeUndefined();
    // El markdown reconstruido gana sobre el texto plano en la respuesta final.
    expect(out.reply.text).toBe("**Hola**, mundo");
  });
});

describe("autoridad y compatibilidad", () => {
  test("T7 el navegador no puede imponer una /c/: el panel solo reenvia chat_id + message", async () => {
    const chat = createChat();
    let forwarded: unknown = null;
    const fakeBridge = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        forwarded = await req.json();
        return Response.json({ ok: true });
      },
    });
    try {
      const url = new URL(`http://127.0.0.1/api/chats/${chat.id}/messages`);
      const res = await handleChatApi(new Request(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hola", conversation_url: "https://chatgpt.com/c/evil-0000-0000", navigate: { to: "conversation", url: "https://evil" } }),
      }), url, String(fakeBridge.port));
      expect(res.status).toBe(200);
      expect(forwarded).toEqual({ chat_id: chat.id, message: "hola" });
    } finally {
      fakeBridge.stop(true);
    }
    expect(() => navigationTarget("https://chatgpt.com/", { to: "conversation", url: "https://evil.example/c/abc12345" })).toThrow(/web_bad_conversation_url/);
    expect(canonicalConversationUrl("https://chatgpt.com.evil.com/c/abc12345")).toBeNull();
    expect(canonicalConversationUrl("http://chatgpt.com/c/abc12345")).toBeNull();
  });

  test("bridge apagado -> 503 bridge_unavailable (no un 500 generico)", async () => {
    const chat = createChat();
    const url = new URL(`http://127.0.0.1/api/chats/${chat.id}/messages`);
    const res = await handleChatApi(new Request(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hola" }),
    }), url, "1");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("bridge_unavailable");
  });

  test("T5 /v1/chat/completions conserva su contrato (transcript completo)", () => {
    const web = chatBodyToWebRequest({
      model: "chatgpt-web/gpt-5.6-sol",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "primero" },
        { role: "assistant", content: "resp" },
        { role: "user", content: "segundo" },
      ],
    });
    expect(web?.prompt).toBe("sys\n\nuser: primero\n\nassistant: resp\n\nuser: segundo");
  });

  test("la ruta OpenAI vuelve a SU conversacion casada aunque el panel movio la pestana", () => {
    const married = "https://chatgpt.com/c/1234abcd-0000-0000-0000-000000000000";
    const nav = defaultNavigation({ name: "default", statePath: "x", conversationUrl: married, updatedAt: "" });
    expect(nav).toEqual({ to: "conversation", url: married });
    expect(navigationTarget("https://chatgpt.com/c/9999ffff-0000-0000-0000-000000000000", nav)).toBe(married);
    expect(navigationTarget(married, nav)).toBeNull();
    expect(defaultNavigation({ name: "default", statePath: "x", conversationUrl: null, updatedAt: "" })).toEqual({ to: "new" });
    expect(defaultNavigation(null)).toBeUndefined();
    // Sin navigate: comportamiento historico (no navega).
    expect(navigationTarget("https://chatgpt.com/c/9999ffff-0000-0000-0000-000000000000", undefined)).toBeNull();
  });
});
