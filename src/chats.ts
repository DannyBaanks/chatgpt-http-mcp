// chats.ts — registro local de chats del panel (Fase 1 del chat UI).
//
//   ~/.codex-web-http/chats/<chat_id>.json   (dir 0700, archivos 0600)
//
// Un chat local = UNA conversacion real de chatgpt.com (/c/). El navegador
// solo conoce chat_id; la URL /c/ la resuelve el backend desde aqui (la URL
// nunca es input de autoridad del API local).
//
// `messages` es una PROYECCION para la UI, no la fuente de verdad: ChatGPT
// guarda la conversacion. Hace falta porque al recargar localhost o cambiar de
// chat la UI tiene que mostrar el historial sin navegar Chrome (que esta
// serializado y tarda segundos). Se limita a los ultimos MAX_MESSAGES.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "./codex-sessions";
import type { ToolCard } from "./tool-trace";

export const CHAT_ID_RE = /^c_[0-9a-f]{16}$/;
export const MAX_MESSAGES = 200;
const SCHEMA = "isymcp.chat/1";

export type ChatErrorKind = "provider_blocked" | "session" | "browser" | "bridge" | "unavailable" | "capture" | "tools_session";

export interface ChatMessage {
  role: "user" | "assistant" | "error";
  text: string;
  ts: string;
  /** Solo respuestas/errores. */
  meta?: {
    ms?: number; url?: string | null; kind?: ChatErrorKind; detail?: string;
    thought?: string;
    /** Turno con tools: tarjetas sacadas de mcp-trace (evidencia), no del modelo. */
    tools_enabled?: boolean;
    tools?: ToolCard[];
  };
}

export interface ChatRecord {
  schema: string;
  id: string;
  title: string;
  conversation_url: string | null;
  created_at: string;
  updated_at: string;
  /** Siempre false al crear: las tools se encienden a mano, chat por chat. */
  tools_enabled: boolean;
  /** fp de la sesion elegida (referencia; el token nunca se guarda aqui). */
  session_fp: string | null;
  messages: ChatMessage[];
}

export function chatsDir(): string {
  return join(bridgeHome(), "chats");
}

/** Path del chat SOLO si el id es valido: nada de ../ ni ids arbitrarios. */
export function chatPath(id: string): string | null {
  return CHAT_ID_RE.test(id) ? join(chatsDir(), `${id}.json`) : null;
}

function ensureDir(): void {
  mkdirSync(chatsDir(), { recursive: true, mode: 0o700 });
  chmodSync(chatsDir(), 0o700);
}

export function saveChat(chat: ChatRecord): void {
  const path = chatPath(chat.id);
  if (!path) throw new Error(`chat_id invalido: ${chat.id}`);
  ensureDir();
  const trimmed = { ...chat, messages: chat.messages.slice(-MAX_MESSAGES) };
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function createChat(title = "Nuevo chat"): ChatRecord {
  const now = new Date().toISOString();
  const chat: ChatRecord = {
    schema: SCHEMA,
    id: `c_${randomBytes(8).toString("hex")}`,
    title: title.trim().slice(0, 80) || "Nuevo chat",
    conversation_url: null,
    created_at: now,
    updated_at: now,
    tools_enabled: false,
    session_fp: null,
    messages: [],
  };
  saveChat(chat);
  return chat;
}

export function loadChat(id: string): ChatRecord | null {
  const path = chatPath(id);
  if (!path || !existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as ChatRecord;
    if (data.id !== id) return null;
    return {
      ...data,
      tools_enabled: data.tools_enabled === true,
      session_fp: typeof data.session_fp === "string" ? data.session_fp : null,
      messages: Array.isArray(data.messages) ? data.messages : [],
    };
  } catch {
    return null;
  }
}

export function listChats(): ChatRecord[] {
  if (!existsSync(chatsDir())) return [];
  return readdirSync(chatsDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => loadChat(name.slice(0, -5)))
    .filter((chat): chat is ChatRecord => chat !== null)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** Vista para el navegador: sin nada que no deba ver (hoy no hay secretos
 * en el registro, pero el contrato es explicito). */
export function publicChat(chat: ChatRecord, withMessages: boolean) {
  return {
    id: chat.id,
    title: chat.title,
    conversation_url: chat.conversation_url,
    created_at: chat.created_at,
    updated_at: chat.updated_at,
    tools_enabled: chat.tools_enabled,
    session_fp: chat.session_fp,
    message_count: chat.messages.length,
    ...(withMessages ? { messages: chat.messages } : {}),
  };
}

/** Poda y compacta el historial de mensajes de un chat para mantener la eficiencia de contexto. */
export function pruneMessages(messages: ChatMessage[], maxMessages = 40): ChatMessage[] {
  if (messages.length <= maxMessages) return [...messages];
  const initial = messages[0];
  const tailCount = Math.max(1, maxMessages - 2);
  const tail = messages.slice(-tailCount);
  const prunedCount = messages.length - 1 - tail.length;

  const note: ChatMessage = {
    role: "assistant",
    text: `[Contexto compactado: se podaron ${prunedCount} mensajes intermedios para optimizar la ventana de contexto]`,
    ts: new Date().toISOString(),
  };

  return initial ? [initial, note, ...tail] : [note, ...tail];
}

/** Compacta un ChatRecord persistido o en memoria. */
export function compactChat(chat: ChatRecord, maxMessages = 40): { compacted: boolean; prunedCount: number; chat: ChatRecord } {
  if (chat.messages.length <= maxMessages) {
    return { compacted: false, prunedCount: 0, chat };
  }
  const originalCount = chat.messages.length;
  const compactedMessages = pruneMessages(chat.messages, maxMessages);
  const prunedCount = originalCount - compactedMessages.length;

  const updatedChat: ChatRecord = {
    ...chat,
    messages: compactedMessages,
    updated_at: new Date().toISOString(),
  };

  return {
    compacted: true,
    prunedCount,
    chat: updatedChat,
  };
}

