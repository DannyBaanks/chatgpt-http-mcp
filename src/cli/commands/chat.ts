// src/cli/commands/chat.ts — `isymcp ask`: turno real con ChatGPT desde la terminal.
import { createChat, loadChat } from "../../chats";
import { bridgeAuthHeaders } from "../../local-guard";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE, RUN, serverUp } from "../services";
import { status } from "./status";
import type { CliModule } from "../module";
import { parseBrowserOption, rejectUnavailableBrowser } from "../../visible/native-browser";

export const CLI_CHAT = join(RUN, "cli-chat");

export function cliChatId(fresh: boolean, firstMessage: string): string {
  if (!fresh && existsSync(CLI_CHAT)) {
    const id = readFileSync(CLI_CHAT, "utf8").trim();
    if (loadChat(id)) return id;
  }
  const chat = createChat(`[terminal] ${firstMessage.replace(/\s+/g, " ").slice(0, 60)}`);
  mkdirSync(RUN, { recursive: true });
  writeFileSync(CLI_CHAT, `${chat.id}\n`);
  return chat.id;
}

export async function askChatGPT(message: string, fresh = false): Promise<boolean> {
  if (!message.trim()) {
    console.error("mensaje vacio");
    return false;
  }
  if (!(await serverUp())) {
    console.error(`el server no responde en ${BRIDGE}. Levantalo con: isymcp up`);
    return false;
  }
  const chatId = cliChatId(fresh, message);
  const started = Date.now();
  const tty = !!process.stderr.isTTY;
  const paint = (code: string, text: string) => (tty && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
  let shown = "";
  let phase = "";
  // Progreso en vivo (stderr): fase y texto parcial, como en el panel.
  const poll = setInterval(async () => {
    try {
      const st = (await (await fetch(`${BRIDGE}/isymcp/chat/status`, { headers: bridgeAuthHeaders(), signal: AbortSignal.timeout(1_500) })).json()) as {
        phase: string; chat_id: string | null; queued: number; partial?: string;
      };
      if (!tty) return;
      const mine = st.chat_id === chatId;
      const label = mine ? st.phase : st.queued > 0 ? "en cola (otro turno en curso)" : st.phase;
      if (label !== phase) {
        phase = label;
        process.stderr.write(`${paint("2", `· ${label} (${Math.round((Date.now() - started) / 1000)} s)`)}\n`);
      }
      if (mine && st.partial && st.partial.startsWith(shown) && st.partial.length > shown.length) {
        process.stderr.write(paint("2", st.partial.slice(shown.length)));
        shown = st.partial;
      }
    } catch { /* el poll es cosmetico */ }
  }, 700);
  try {
    const res = await fetch(`${BRIDGE}/isymcp/chat/turn`, {
      method: "POST",
      headers: bridgeAuthHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ chat_id: chatId, message }),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; reply?: { text?: string; meta?: { kind?: string; detail?: string } }; chat?: { conversation_url?: string | null }; error?: { type?
        : string; message?: string } }
      | null;
    clearInterval(poll);
    if (shown && tty) process.stderr.write(`\n${paint("2", "── respuesta final ──")}\n`);
    if (!res.ok || !body) {
      console.error(`error ${res.status}: ${body?.error?.type ?? ""} ${body?.error?.message ?? "respuesta ilegible"}`);
      return false;
    }
    console.log(body.reply?.text ?? "");
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!body.ok) console.error(paint("31", `✗ ${body.reply?.meta?.kind ?? "error"} · ${body.reply?.meta?.detail ?? ""}`));
    console.error(paint("2", `${body.ok ? "✓" : "✗"} ${secs} s · chat ${chatId} · ${body.chat?.conversation_url ?? "sin /c/"} · sigue en el panel`));
    return body.ok === true;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    clearInterval(poll);
  }
}

export const askModule: CliModule = {
  names: ["ask"],
  async run(sub, rest) {
    let selected: ReturnType<typeof parseBrowserOption>;
    try { selected = parseBrowserOption([sub, ...rest].filter((a): a is string => Boolean(a))); }
    catch (error) { console.error(error instanceof Error ? error.message : "browser_selection_invalid"); process.exit(2); }
    const denied = rejectUnavailableBrowser(selected.browser);
    if (denied) {
      const body = await denied.json();
      console.error(`${body.error.type}: ${body.error.message}`);
      process.exit(2);
    }
    const args = selected.args;
    const fresh = args.includes("--new");
    let text = args.filter((a) => a !== "--new").join(" ");
    if (!text && !process.stdin.isTTY) text = await Bun.stdin.text();
    if (!text.trim()) {
      console.error('uso: isymcp ask "texto" [--new]   (o por stdin: echo hola | isymcp ask)');
      process.exit(2);
    }
    if (!(await askChatGPT(text, fresh))) process.exitCode = 1;
  },
};
