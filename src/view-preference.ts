export const CHAT_VIEWS = ["conversation", "evidence", "activity"] as const;
export type ChatView = typeof CHAT_VIEWS[number];

export const DEFAULT_CHAT_VIEW: ChatView = "conversation";
export const CHAT_VIEW_PREFERENCE_KEY = "isymcp.chat.view";

type ViewPreferenceStorage = Pick<Storage, "getItem">;

export function normalizeChatView(value: unknown): ChatView {
  return typeof value === "string" && (CHAT_VIEWS as readonly string[]).includes(value)
    ? value as ChatView
    : DEFAULT_CHAT_VIEW;
}

/** Reads the UI preference without making storage availability a requirement. */
export function readChatViewPreference(storage?: ViewPreferenceStorage | null): ChatView {
  if (!storage) return DEFAULT_CHAT_VIEW;
  try {
    return normalizeChatView(storage.getItem(CHAT_VIEW_PREFERENCE_KEY));
  } catch {
    return DEFAULT_CHAT_VIEW;
  }
}
