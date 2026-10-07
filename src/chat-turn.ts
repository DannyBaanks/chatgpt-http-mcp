// chat-turn.ts — un turno del chat local (panel) contra SU conversacion /c/.
//
// Vive en el proceso del bridge porque ahi vive la unica pestana de Chrome:
// el panel solo hace de proxy. Semantica distinta a /v1/chat/completions a
// proposito (ese contrato no se toca):
//   - se envia SOLO el mensaje nuevo (ChatGPT ya tiene el contexto remoto);
//   - chat_id -> /c/ se resuelve aqui desde el registro (nunca del navegador);
//   - chat nuevo: navega a una conversacion nueva, manda el primer mensaje,
//     captura la URL canonica /c/ y la persiste (si no hay /c/ o choca con la
//     de otro chat, NO se persiste y el turno se marca como error de captura);
//   - todo corre dentro de withWebLock: cambiar de chat nunca puede tocar la
//     pestana mientras otro turno esta activo.
import { randomBytes } from "node:crypto";
import type { AppConfig } from "./config";
import { isExpired, listUserSessions, mintTurnToken, revokeTurnToken, type CodexSession } from "./codex-sessions";
import { buildChatGPTCommand, CONNECTOR_NAME } from "./mcp/identity";
import { readTraceSince, toolCards, traceSize, type ToolCard } from "./tool-trace";
import { classifyWebError } from "./error-taxonomy";
import {
  CHAT_ID_RE, listChats, loadChat, saveChat,
  type ChatErrorKind, type ChatMessage, type ChatRecord,
} from "./chats";
import {
  canonicalConversationUrl, sendWebTurn, withWebLock,
  type WebTurnOptions, type WebTurnResult,
} from "./web-turn";

export const MAX_CHAT_MESSAGE_CHARS = 100_000;

export type ChatPhase = "idle" | "queued" | "navigating" | "thinking";
// Estado para la UI: el turno activo (dentro del candado) y cuantos esperan.
let active: { chat_id: string; phase: Exclude<ChatPhase, "idle" | "queued">; since: string; partial?: string; tools?: ToolCard[] } | null = null;
let queued = 0;
export function chatStatus(): { phase: ChatPhase; chat_id: string | null; queued: number; since: string | null; partial?: string; tools?: ToolCard[] } {
  if (active) {
    return {
      phase: active.phase, chat_id: active.chat_id, queued, since: active.since,
      ...(active.partial ? { partial: active.partial } : {}),
      ...(active.tools?.length ? { tools: active.tools } : {}),
    };
  }
  return { phase: queued > 0 ? "queued" : "idle", chat_id: null, queued, since: null };
}

/**
 * Bloqueos de seguridad de OpenAI: llegan como TEXTO del asistente, no como
 * error HTTP. No son fallos del bridge (evidencia: soak 100 turno 95, soak-tools
 * turno 2) y la tool no llego a ejecutarse.
 */
const PROVIDER_BLOCK_PATTERNS = [
  /bloquead[oa] por los controles de seguridad de OpenAI/i,
  /OpenAI ha bloqueado esta llamada/i,
  /blocked by OpenAI'?s? (?:safety|security)/i,
  /OpenAI (?:has )?blocked this (?:tool )?call/i,
];
export function isProviderBlock(text: string): boolean {
  return PROVIDER_BLOCK_PATTERNS.some((re) => re.test(text));
}

/** Quien fallo, a partir del tipo nombrado del bridge. */
export function errorKind(message: string): ChatErrorKind {
  const { type } = classifyWebError(message);
  if (type === "web_session_missing" || type === "web_session_expired") return "session";
  if (type === "web_page_crashed" || type === "web_browser_missing") return "browser";
  if (type === "web_capture_empty" || type === "web_no_response") return "capture";
  return "bridge";
}

export class ChatTurnError extends Error {
  constructor(readonly status: number, readonly type: string, message: string) {
    super(message);
  }
}

export interface ChatTurnDeps {
  send: (prompt: string, options: WebTurnOptions) => Promise<WebTurnResult>;
}

export interface ChatTurnOutcome {
  ok: boolean;
  chat: ChatRecord;
  reply: ChatMessage;
}

function deriveTitle(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || "Nuevo chat";
}

export async function runChatTurn(
  chatId: string,
  rawMessage: string,
  config: AppConfig,
  deps: ChatTurnDeps = { send: sendWebTurn },
): Promise<ChatTurnOutcome> {
  if (!CHAT_ID_RE.test(chatId)) throw new ChatTurnError(400, "chat_bad_id", "chat_id invalido");
  const message = rawMessage.trim();
  if (!message) throw new ChatTurnError(400, "chat_empty_message", "mensaje vacio");
  if (message.length > MAX_CHAT_MESSAGE_CHARS) {
    throw new ChatTurnError(413, "chat_message_too_long", `mensaje de mas de ${MAX_CHAT_MESSAGE_CHARS} caracteres`);
  }
  if (!loadChat(chatId)) throw new ChatTurnError(404, "chat_not_found", "chat desconocido");

  queued++;
  let entered = false;
  try {
    return await withWebLock(async () => {
      queued--;
      entered = true;
      active = { chat_id: chatId, phase: "navigating", since: new Date().toISOString() };
      try {
        return await turnInsideLock(chatId, message, config, deps, (phase) => {
          active = { chat_id: chatId, phase, since: new Date().toISOString() };
        }, (partial) => {
          // Texto en vivo para la UI: la respuesta completa hasta ahora.
          if (active?.chat_id === chatId) active = { ...active, phase: "thinking", partial };
        }, (tools) => {
          // Tarjetas en vivo, desde la traza del MCP (evidencia).
          if (active?.chat_id === chatId) active = { ...active, tools };
        });
      } finally {
        // Dentro del candado: el siguiente turno aun no pudo empezar.
        active = null;
      }
    });
  } finally {
    if (!entered) queued--;
  }
}

async function turnInsideLock(
  chatId: string,
  message: string,
  config: AppConfig,
  deps: ChatTurnDeps,
  onPhase: (phase: "navigating" | "thinking") => void,
  onProgress: (partial: string) => void = () => {},
  onTools: (cards: ToolCard[]) => void = () => {},
): Promise<ChatTurnOutcome> {
  // Releer DENTRO del candado: el turno anterior pudo fijar la /c/.
  const chat = loadChat(chatId);
  if (!chat) throw new ChatTurnError(404, "chat_not_found", "chat desconocido");
  const started = Date.now();
  const firstTurn = chat.conversation_url === null;
  chat.messages.push({ role: "user", text: message, ts: new Date().toISOString() });
  if (firstTurn && chat.title === "Nuevo chat") chat.title = deriveTitle(message);
  chat.updated_at = new Date().toISOString();
  saveChat(chat);

  // Fase 2: con tools, un token EFIMERO por turno (nunca el de la sesion).
  // Se declaran antes de fail(): fail adjunta las tarjetas del turno.
  let turnToken: CodexSession | null = null;
  let traceStart = 0;
  const cardsNow = (): ToolCard[] => (turnToken ? toolCards(readTraceSince(traceStart, turnToken.fp)) : []);
  const toolsMeta = (): { tools_enabled?: boolean; tools?: ToolCard[] } => {
    if (!chat.tools_enabled) return {};
    let cards: ToolCard[] = [];
    try { cards = cardsNow(); } catch { /* traza ilegible: sin tarjetas */ }
    return { tools_enabled: true, ...(cards.length ? { tools: cards } : {}) };
  };

  const fail = (kind: ChatErrorKind, text: string, detail?: string): ChatTurnOutcome => {
    const reply: ChatMessage = {
      role: "error", text, ts: new Date().toISOString(),
      meta: { kind, ms: Date.now() - started, url: chat.conversation_url, ...(detail ? { detail: detail.slice(0, 600) } : {}), ...toolsMeta() },
    };
    chat.messages.push(reply);
    chat.updated_at = reply.ts;
    saveChat(chat);
    return { ok: false, chat, reply };
  };

  if (chat.tools_enabled) {
    const parent = chat.session_fp ? listUserSessions().find((x) => x.fp === chat.session_fp) : undefined;
    if (!parent || isExpired(parent)) {
      return fail("tools_session", "La sesion de tools de este chat ya no existe o caduco. Elige otra en el panel.");
    }
    turnToken = mintTurnToken(parent.fp, `${chatId}:${randomBytes(4).toString("hex")}`);
  }
  traceStart = traceSize();
  const toolTimer = turnToken ? setInterval(() => { try { onTools(cardsNow()); } catch { /* UI */ } }, 800) : null;
  try {
    return await sendAndRecord();
  } finally {
    if (toolTimer) clearInterval(toolTimer);
    // El token del turno muere con el turno (aunque haya fallado).
    if (turnToken) revokeTurnToken(turnToken.fp);
  }

  async function sendAndRecord(): Promise<ChatTurnOutcome> {
    let result: WebTurnResult;
    try {
      result = await deps.send(turnToken ? buildChatGPTCommand(message, { turnToken: turnToken.token }) : message, {
        statePath: config.browserStatePath,
        browser: config.browser,
        headed: config.browserHeaded,
        // Con tools el modelo hace rondas de llamadas: mas margen.
        deadlineMs: turnToken ? Math.max(config.webTurnDeadlineMs, 180_000) : config.webTurnDeadlineMs,
        // Sin tools, "" anula CODEX_WEB_HTTP_CONNECTOR del entorno.
        connector: turnToken ? CONNECTOR_NAME : "",
        // Para el reviver: si Chrome se cae, relanza en ESTA conversacion.
        conversationUrl: chat.conversation_url ?? undefined,
        navigate: firstTurn ? { to: "new" } : { to: "conversation", url: chat.conversation_url! },
        onPhase,
        onProgress,
        // Sondeo mas fino para que el texto en vivo se vea fluido.
        settleMs: 500,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const kind = errorKind(detail);
      const text = kind === "session" ? "La sesion de ChatGPT no esta activa (cookies vencidas o faltantes)."
        : kind === "browser" ? "Chrome se cayo y no se pudo recuperar el turno."
          : kind === "capture" ? "ChatGPT no devolvio una respuesta legible a tiempo."
            : "El bridge local no completo el turno.";
      return fail(kind, text, detail);
    }

    const canonical = canonicalConversationUrl(result.url);
    if (firstTurn) {
      if (!canonical) {
        return fail("capture", "No se pudo capturar la conversacion de ChatGPT (/c/) de este chat.", `url=${result.url}`);
      }
      const clash = listChats().find((other) => other.id !== chat.id && other.conversation_url === canonical);
      if (clash) {
        return fail("capture", "La conversacion capturada ya pertenece a otro chat; no se asocio.", `url=${canonical} chat=${clash.id}`);
      }
      chat.conversation_url = canonical;
    } else if (canonical !== chat.conversation_url) {
      return fail("capture", "La pestana termino en otra conversacion; la respuesta no se asocio a este chat.", `esperada=${chat.conversation_url} real=${result.url}`);
    }

    if (!result.submitted) return fail("bridge", "El mensaje no llego a enviarse en ChatGPT.", `ms=${result.ms}`);
    if (!result.text) return fail("capture", "ChatGPT no devolvio una respuesta legible a tiempo.", `ms=${result.ms}`);
    if (isProviderBlock(result.text)) {
      return fail("provider_blocked", result.text);
    }
    const reply: ChatMessage = {
      // Markdown reconstruido si el bridge lo trae (listas, codigo); si no, texto plano.
      role: "assistant", text: result.markdown?.trim() || result.text, ts: new Date().toISOString(),
      meta: { ms: Date.now() - started, url: chat.conversation_url, ...toolsMeta() },
    };
    chat.messages.push(reply);
    chat.updated_at = reply.ts;
    saveChat(chat);
    return { ok: true, chat, reply };
  }
}
