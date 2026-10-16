// panel-chat.ts — pestana "Chat" del panel: chats, texto en vivo, tools y ajustes.
//
// El navegador es una VISTA: solo conoce chat_id y el texto que escribe. El
// backend (bridge) resuelve chat_id -> /c/ y habla con ChatGPT. Ningun token,
// cookie ni storage-state pasa por aqui.
//
// Todo el DOM se construye con textContent; lo unico que entra como HTML es la
// salida de renderMarkdown (que escapa todo antes de transformar).
import { renderMarkdown } from "./markdown";
import { MAX_DRAFT_LENGTH } from "./chats";
import { CHAT_VIEWS, CHAT_VIEW_PREFERENCE_KEY, DEFAULT_CHAT_VIEW, normalizeChatView, readChatViewPreference, type ChatView } from "./view-preference";
const CLIENT_CHAT_VIEWS: readonly ChatView[] = CHAT_VIEWS;

export type PanelReceiptState = "running" | "ok" | "failed";
export interface PanelReceipt {
  tool: string;
  summary: string;
  state: PanelReceiptState;
  correlation: "exact" | "legacy";
  exit_code?: number;
  duration_ms?: number;
  error?: string;
}
export type PanelEvidenceFilter = "all" | "failed" | "completed";
export interface PanelSavedReceipt { index: number; card: PanelReceipt }

/** Serializes writes per chat so a slow earlier request cannot overwrite a newer draft. */
export function createSerializedDraftWriter(write: (id: string, draft: string, revision: number, keepalive?: boolean) => Promise<unknown>) {
  const pending = new Map<string, Promise<unknown>>();
  return (id: string, draft: string, revision: number, keepalive = false): Promise<unknown> => {
    const previous = pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => write(id, draft, revision, keepalive));
    pending.set(id, next);
    void next.finally(() => { if (pending.get(id) === next) pending.delete(id); }).catch(() => undefined);
    return next;
  };
}

/** Result policy for a submitted draft; edits made during a turn always win. */
export function draftAfterSend(sent: string, current: string, changedDuringSend: boolean, succeeded: boolean): string {
  if (changedDuringSend) return current;
  return succeeded ? "" : sent;
}

/** Prefer tab-local text/selection when switching back; use persisted text after reload. */
export function restoreDraftState(local: { text: string; start: number; end: number } | null, persisted: unknown) {
  if (local && typeof local.text === "string") return { text: local.text, start: local.start, end: local.end };
  const text = typeof persisted === "string" ? persisted : "";
  return { text, start: text.length, end: text.length };
}

/** Include saves still debounced or in flight, plus the current editor value, on pagehide. */
export function draftsToPersistOnPageHide(
  currentId: string | null,
  current: { text: string; revision: number } | null,
  dirtyDrafts: Iterable<readonly [string, { text: string; revision: number }]>,
): Array<[string, { text: string; revision: number }]> {
  const drafts = new Map(dirtyDrafts);
  if (currentId && current) drafts.set(currentId, current);
  return [...drafts.entries()];
}

/** Browser-side allowlist for already-projected saved cards and live status cards. */
export function projectPanelReceipt(value: unknown): PanelReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = value as Record<string, unknown>;
  if (typeof card.tool !== "string" || typeof card.summary !== "string" ||
      (card.state !== "running" && card.state !== "ok" && card.state !== "failed")) return null;
  return {
    tool: card.tool,
    summary: card.summary,
    state: card.state,
    correlation: card.correlation === "exact" ? "exact" : "legacy",
    ...(typeof card.exit_code === "number" && Number.isFinite(card.exit_code) ? { exit_code: card.exit_code } : {}),
    ...(typeof card.duration_ms === "number" && Number.isFinite(card.duration_ms) ? { duration_ms: card.duration_ms } : {}),
    ...(typeof card.error === "string" ? { error: card.error } : {}),
  };
}

export function projectSavedReceipts(messages: unknown, filter: PanelEvidenceFilter = "all"):
  { state: "none" | "filtered" | "receipts"; receipts: PanelSavedReceipt[] } {
  const receipts: PanelSavedReceipt[] = [];
  if (Array.isArray(messages)) messages.forEach((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const meta = (message as Record<string, unknown>).meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
    const tools = (meta as Record<string, unknown>).tools;
    if (!Array.isArray(tools)) return;
    for (const value of tools) {
      const card = projectPanelReceipt(value);
      if (card) receipts.push({ index, card });
    }
  });
  const filtered = receipts.filter(({ card }) => filter === "failed" ? card.state === "failed" : filter === "completed" ? card.state === "ok" : true);
  return { state: filtered.length ? "receipts" : receipts.length ? "filtered" : "none", receipts: filtered };
}

export function receiptLegacyLabel(card: PanelReceipt): string | null {
  return card.correlation === "exact" ? null : "Comprobante heredado: la correlación exacta de esta llamada no está disponible.";
}

export interface PanelActivitySnapshot {
  bridge: "pending" | "available" | "unavailable";
  relation: "unknown" | "other" | "selected" | "queued_unattributed" | "none";
  phase?: string;
  since?: string;
  queued?: number;
  tools?: PanelReceipt[];
}

/** Removes global phase/tools whenever the status chat does not match the selected chat. */
export function projectPanelActivity(status: unknown, selectedChatId: string | null, unavailable = false): PanelActivitySnapshot {
  if (unavailable) return { bridge: "unavailable", relation: "unknown" };
  if (!status || typeof status !== "object" || Array.isArray(status)) return { bridge: "pending", relation: "unknown" };
  const value = status as Record<string, unknown>;
  const queued = typeof value.queued === "number" && Number.isFinite(value.queued) && value.queued >= 0 ? value.queued : undefined;
  if (typeof value.chat_id === "string" && value.chat_id !== selectedChatId)
    return { bridge: "available", relation: "other" };
  if (selectedChatId && value.chat_id === selectedChatId) {
    return {
      bridge: "available",
      relation: "selected",
      ...(typeof value.phase === "string" ? { phase: value.phase } : {}),
      ...(typeof value.since === "string" ? { since: value.since } : {}),
      ...(queued !== undefined ? { queued } : {}),
      ...(Array.isArray(value.tools) ? { tools: value.tools.map(projectPanelReceipt).filter((card): card is PanelReceipt => card !== null) } : {}),
    };
  }
  if (value.phase === "queued" || (queued !== undefined && queued > 0))
    return { bridge: "available", relation: "queued_unattributed", ...(queued !== undefined ? { queued } : {}) };
  return { bridge: "available", relation: "none", ...(queued !== undefined ? { queued } : {}) };
}

export interface PanelPendingChatStatus {
  matchesChat: boolean;
  phase?: string;
  thought?: string;
  partial?: string;
  tools?: PanelReceipt[];
}

/** Allows live assistant content through only when status names this exact chat. */
export function projectPendingChatStatus(status: unknown, selectedChatId: string): PanelPendingChatStatus {
  if (!status || typeof status !== "object" || Array.isArray(status)) return { matchesChat: false };
  const value = status as Record<string, unknown>;
  if (!selectedChatId || value.chat_id !== selectedChatId) return { matchesChat: false };
  return {
    matchesChat: true,
    ...(typeof value.phase === "string" ? { phase: value.phase } : {}),
    ...(typeof value.thought === "string" ? { thought: value.thought } : {}),
    ...(typeof value.partial === "string" ? { partial: value.partial } : {}),
    ...(Array.isArray(value.tools) ? { tools: value.tools.map(projectPanelReceipt).filter((card): card is PanelReceipt => card !== null) } : {}),
  };
}

export const CHAT_STYLE = `
.chat{display:grid;grid-template-columns:54px 236px minmax(0,1fr) 290px;height:calc(100vh - 57px);min-height:0}
.chat>*{min-width:0;min-height:0}
.rail{display:flex;flex-direction:column;align-items:center;gap:8px;background:#090c0a;border-right:1px solid var(--line);padding:10px 5px}
.rail-spacer{flex:1}
.rail-btn{width:44px;height:44px;display:grid;place-items:center;border:1px solid transparent;border-radius:11px;background:transparent;color:#9aa89f;font:18px var(--sans);cursor:pointer;text-decoration:none}
.rail-btn:hover,.rail-btn:focus-visible{background:#151b18;color:var(--ink);border-color:#354239}
.rail-btn[aria-current="page"],.rail-btn[aria-expanded="true"]{background:#18201c;color:var(--ok);border-color:#26332b}
.rail-brand{font:700 13px var(--mono);letter-spacing:.04em;color:var(--ok)}
.side,.config{background:#0c0f0d;border-color:var(--line);border-style:solid;border-width:0;overflow:auto;overscroll-behavior:contain}
.side{border-right-width:1px;padding:14px 12px}
.config{border-left-width:1px;padding:16px}
.drawer-heading{display:flex;align-items:center;justify-content:space-between;margin:0 0 10px}
.drawer-heading h3{margin:0;font:600 11px var(--mono);letter-spacing:.14em;color:var(--mute)}
.drawer-close{display:none}
.newchat{width:100%;display:flex;gap:8px;align-items:center;justify-content:center;font:600 13px var(--sans);color:var(--ink);background:#141a17;border:1px solid var(--line);border-radius:10px;padding:9px;cursor:pointer}
.newchat:hover{border-color:var(--ok)}
.chatlist{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}
.chatlist button{width:100%;text-align:left;background:none;border:0;color:var(--ink);font:13px var(--sans);padding:8px 10px;border-radius:8px;cursor:pointer;display:flex;flex-direction:column;gap:2px}
.chatlist button:hover{background:#141a17}
.chatlist button.on{background:#18201c;box-shadow:inset 2px 0 0 var(--ok)}
.chatlist button{min-height:44px}
.chatlist .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chatlist .s{font:11px var(--mono);color:var(--mute)}
.convo{display:flex;flex-direction:column;min-height:0}
.view-switcher{display:flex;gap:6px;padding:10px 16px 0;max-width:792px;width:100%;margin:0 auto}
.view-tab{border:1px solid var(--line);border-radius:8px;padding:7px 11px;background:#0c100e;color:var(--mute);font:12px var(--mono);cursor:pointer}
.view-tab[aria-selected="true"]{background:#18201c;color:var(--ok);border-color:#354239}
.mode-pane[hidden]{display:none!important}
.msgs.mode-pane{flex:1;overflow:auto;padding:24px max(16px,calc((100% - 760px)/2)) 12px}
.mode-content{width:min(100%,760px);margin:0 auto}
.mode-title{font:600 12px var(--mono);letter-spacing:.1em;color:var(--mute);margin:0 0 12px}
.evidence-filter{margin:0 0 12px;background:#121715;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:7px 9px;font:12px var(--mono)}
.evidence-card,.activity-card{border:1px solid var(--line);border-left:3px solid var(--c);border-radius:10px;background:#0c100e;padding:11px 12px;margin:0 0 9px}
.evidence-card.ok,.activity-card.ok{--c:var(--ok)}.evidence-card.failed,.activity-card.failed{--c:var(--bad)}.evidence-card.running,.activity-card.running{--c:var(--warn)}
.evidence-card .heading,.activity-card .heading{display:flex;gap:8px;align-items:center;font:600 12px var(--mono)}
.evidence-card .summary,.activity-card .summary{font:12px/1.5 var(--mono);color:#cfe3d5;white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0}
.receipt-owner{font:11px var(--mono);color:var(--ok)}
.receipt-legacy{font:11px var(--mono);color:var(--warn);margin-top:5px}
.activity-state{font:13px/1.5 var(--sans);margin:0 0 10px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.msgs{flex:1;overflow:auto;padding:24px max(16px,calc((100% - 760px)/2)) 12px}
.empty{margin:18vh auto 0;text-align:center;color:var(--mute);max-width:420px}
.empty h2{font:700 20px var(--mono);color:var(--ok);letter-spacing:.08em;margin:0 0 8px}
.msg{margin:0 0 18px}
.assistant-origin{display:flex;align-items:center;gap:8px;margin:0 0 7px;color:#aab7af;font:600 11px var(--mono)}
.assistant-origin img{width:22px;height:22px;object-fit:contain;border-radius:50%;background:#171c19;padding:4px}
.msg.user{display:flex;justify-content:flex-end}
.msg.user .bubble{max-width:min(78%,620px);background:#e9efe9;color:#0b0f0d;border-radius:18px 18px 4px 18px;padding:9px 14px;white-space:pre-wrap;overflow-wrap:anywhere}
.msg.assistant .body{overflow-wrap:anywhere}
.body p{margin:0 0 10px}.body ul,.body ol{margin:0 0 10px;padding-left:22px}
.body h3,.body h4,.body h5{margin:14px 0 8px;font-family:var(--mono);color:#e9f5ec}
.body blockquote{margin:0 0 10px;padding:4px 12px;border-left:3px solid var(--line);color:#b7c4bb}
.body a{color:var(--ok)}
.body code{font:12.5px var(--mono);background:#0b0f0d;border:1px solid var(--line);border-radius:5px;padding:1px 5px}
.body pre{position:relative;background:#070908;border:1px solid var(--line);border-radius:10px;padding:30px 14px 12px;overflow:auto;margin:0 0 10px}
.body pre code{border:0;background:none;padding:0;font-size:12.5px;line-height:1.55;white-space:pre}
.body pre .copy{position:absolute;top:6px;right:6px;font:11px var(--mono);color:var(--mute);background:#121815;border:1px solid var(--line);border-radius:6px;padding:2px 8px;cursor:pointer}
.meta{margin-top:6px;font:11px var(--mono);color:var(--mute);display:flex;gap:8px;flex-wrap:wrap}
.meta a{color:var(--mute)}.meta a:hover{color:var(--ok)}
.errcard{border:1px solid color-mix(in srgb,var(--c) 45%,transparent);background:color-mix(in srgb,var(--c) 8%,transparent);border-radius:12px;padding:12px 14px}
.errcard .h{font-weight:600;color:var(--c);display:flex;gap:8px;align-items:center}
.errcard .p{margin-top:4px;color:#d9c9c9;overflow-wrap:anywhere}
.errcard details{margin-top:8px;font:11px var(--mono);color:var(--mute)}
.errcard details pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0}
.errcard .btn{margin-top:10px}
.thought-box{margin:0 0 10px;border:1px solid var(--line);border-radius:10px;background:#090c0a;overflow:hidden}
.thought-box[open]{border-color:#2f3a34}
.thought-summary{font:600 11.5px var(--mono);color:#8ca595;padding:7px 10px;cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;background:#0f1411}
.thought-summary:hover{color:var(--ok)}
.thought-body{font:12px/1.55 var(--sans);color:#aabfb1;padding:8px 12px;white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid var(--line);background:#070908}
.thinking{display:flex;align-items:center;gap:10px;color:var(--mute);font:13px var(--mono)}
.live-body{margin-bottom:8px}
.live-body>:last-child::after{content:'▍';color:var(--ok);margin-left:2px;animation:pulse 1s infinite}
.thinking i{width:8px;height:8px;border-radius:50%;background:var(--ok);animation:pulse 1.2s infinite}
.composer{padding:10px max(16px,calc((100% - 760px)/2)) 16px}
.composer form{display:flex;gap:8px;align-items:flex-end;background:#121715;border:1px solid var(--line);border-radius:16px;padding:8px 8px 8px 14px}
.composer form:focus-within{border-color:#2f3a34}
.composer textarea{flex:1;resize:none;background:none;border:0;outline:0;color:var(--ink);font:14px/1.5 var(--sans);max-height:200px;min-height:24px;padding:4px 0}
.send{flex:none;width:36px;height:36px;border-radius:10px;border:0;background:var(--ok);color:#04140a;font:700 16px var(--mono);cursor:pointer}
.send[disabled]{background:#26302b;color:var(--mute);cursor:not-allowed}
.hint{font:11px var(--mono);color:var(--mute);text-align:center;margin-top:6px}
.config h4{margin:0 0 6px;font:600 11px var(--mono);letter-spacing:.14em;color:var(--mute)}
.config .row{margin:0 0 18px}
.config .val{font:13px var(--sans)}
.config .note{font:11px/1.45 var(--sans);color:var(--mute);margin-top:4px}
.switch{display:inline-flex;align-items:center;gap:8px;background:none;border:0;color:var(--mute);font:600 12px var(--mono);cursor:pointer;padding:0}
.switch span{width:34px;height:18px;border-radius:10px;background:#26302b;position:relative;transition:background .15s}
.switch span::after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#7a8a81;transition:transform .15s,background .15s}
.switch[aria-checked="true"] span{background:color-mix(in srgb,var(--ok) 35%,#26302b)}
.switch[aria-checked="true"] span::after{transform:translateX(16px);background:var(--ok)}
.switch[aria-checked="true"] b{color:var(--ok)}
.switch[disabled]{opacity:.5;cursor:not-allowed}
.select{display:block;width:100%;margin-top:10px;background:#121715;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:12px var(--mono)}
.select[disabled]{opacity:.5}
.tools{display:flex;flex-direction:column;gap:6px;margin:0 0 10px}
.toolcard{border:1px solid var(--line);border-left:3px solid var(--c);border-radius:9px;padding:7px 10px;background:#0c100e}
.toolcard .th{display:flex;gap:10px;align-items:center;font:600 11px var(--mono)}
.toolcard .tn{color:var(--c)}.toolcard .ts{color:var(--mute);margin-left:auto}
.toolcard code{display:block;margin-top:4px;font:12px var(--mono);color:#cfe3d5;white-space:pre-wrap;overflow-wrap:anywhere;background:none;border:0;padding:0}
.toolcard.running{--c:var(--warn)}.toolcard.ok{--c:var(--ok)}.toolcard.failed{--c:var(--bad)}
.tools-none{font:11px var(--mono);color:var(--mute);margin:0 0 8px}
.toggle{display:inline-flex;align-items:center;gap:8px;font:12px var(--mono);color:var(--mute)}
.toggle span{width:30px;height:16px;border-radius:9px;background:#26302b;position:relative}
.toggle span::after{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#5b6b62}
button:focus-visible,a:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--ok);outline-offset:2px}
@media (max-width:1050px){
  .chat{grid-template-columns:54px minmax(0,1fr)}
  .side,.config{position:fixed;top:57px;bottom:0;z-index:7;width:min(340px,88vw);transition:transform .18s ease,visibility .18s;visibility:hidden}
  .side{left:54px;transform:translateX(calc(-100% - 60px));border-right:1px solid var(--line);box-shadow:none}
  .config{right:0;transform:translateX(105%);border-left:1px solid var(--line);box-shadow:none}
  body.show-side .side,body.show-config .config{transform:none;visibility:visible;box-shadow:0 0 40px rgba(0,0,0,.6)}
  .drawer-close{display:inline-flex;min-width:44px;min-height:44px;align-items:center;justify-content:center}
  .convo{grid-column:2}
}
@media (max-width:520px){.chat{grid-template-columns:50px minmax(0,1fr)}.rail{padding-inline:3px}.rail-btn{width:44px;height:46px}.side{left:50px;width:min(330px,calc(100vw - 62px))}.msgs{padding-top:16px}.composer{padding-bottom:max(12px,env(safe-area-inset-bottom))}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
`;

export function renderChatView(): string {
  return `<div class="chat">
  <nav class="rail" aria-label="Navegación del chat">
    <button class="rail-btn" type="button" data-nav="chat" aria-label="Chat y conversaciones" aria-controls="history-panel" aria-expanded="false" aria-current="page" title="Chat">◉</button>
    <button class="rail-btn" type="button" data-nav="sessions" aria-label="Sesiones de tools" aria-controls="config-panel" aria-expanded="false" title="Sesiones">▤</button>
    <button class="rail-btn" type="button" data-nav="activity" aria-label="Actividad y estado del host" title="Actividad y estado">⌘</button>
    <button class="rail-btn" type="button" data-nav="settings" aria-label="Ajustes del chat" aria-controls="config-panel" aria-expanded="false" title="Ajustes">⚙</button>
    <span class="rail-spacer"></span>
    <a class="rail-btn rail-brand" href="#estado" aria-label="ISyMCP, abrir estado del host" title="Estado de ISyMCP">I</a>
  </nav>
  <aside class="side" id="history-panel" aria-label="Chats recientes" aria-hidden="false">
    <div class="drawer-heading"><h3>CHATS RECIENTES</h3><button class="btn drawer-close" type="button" data-close-drawer aria-label="Cerrar historial">×</button></div>
    <button class="newchat" id="newchat" type="button">＋ Nuevo chat</button>
    <ul class="chatlist" id="chatlist" aria-label="Conversaciones recientes"></ul>
  </aside>
  <section class="convo">
    <nav class="view-switcher" aria-label="Vistas de conversación" role="tablist">
      <button class="view-tab" id="tab-conversation" type="button" role="tab" data-view="conversation" aria-controls="msgs" aria-selected="true">Conversación</button>
      <button class="view-tab" id="tab-evidence" type="button" role="tab" data-view="evidence" aria-controls="evidence-view" aria-selected="false">Evidencia</button>
      <button class="view-tab" id="tab-activity" type="button" role="tab" data-view="activity" aria-controls="activity-view" aria-selected="false">Actividad</button>
    </nav>
    <div class="msgs mode-pane" id="msgs" role="tabpanel" aria-labelledby="tab-conversation" data-panel="conversation"></div>
    <section class="msgs mode-pane" id="evidence-view" role="tabpanel" aria-labelledby="tab-evidence" data-panel="evidence" hidden>
      <div class="mode-content"><h2 class="mode-title">COMPROBANTES GUARDADOS EN ESTE CHAT</h2>
        <label class="sr-only" for="evidence-filter">Filtrar comprobantes</label>
        <select class="evidence-filter" id="evidence-filter"><option value="all">Todas</option><option value="failed">Fallidas</option><option value="completed">Completadas</option></select>
        <div id="evidence-list"></div>
      </div>
    </section>
    <section class="msgs mode-pane" id="activity-view" role="tabpanel" aria-labelledby="tab-activity" data-panel="activity" hidden>
      <div class="mode-content"><h2 class="mode-title">ESTADO DEL TURNO Y DEL BRIDGE</h2>
        <p class="activity-state" id="activity-bridge">Estado del bridge pendiente.</p>
        <div id="activity-status"></div>
        <h3 class="mode-title">COMPROBANTES DE ESTE CHAT</h3><div id="activity-receipts"></div>
      </div>
    </section>
    <div id="phase-live" class="sr-only" aria-live="polite" aria-atomic="true"></div>
    <div class="composer">
      <form id="composer">
        <textarea id="input" rows="1" maxlength="${MAX_DRAFT_LENGTH}" aria-label="Escribe un mensaje para ChatGPT" placeholder="Escribe un mensaje… (Enter envía, Shift+Enter nueva línea)"></textarea>
        <button class="send" id="send" type="submit" title="Enviar">↑</button>
      </form>
      <div class="hint" id="hint">cada chat es su propia conversación en chatgpt.com</div>
    </div>
  </section>
  <aside class="config" id="config-panel" aria-label="Ajustes y sesiones" aria-hidden="false">
    <div class="drawer-heading"><h3 id="config-title">AJUSTES Y SESIONES</h3><button class="btn drawer-close" type="button" data-close-drawer aria-label="Cerrar ajustes y sesiones">×</button></div>
    <div class="row"><h4>AJUSTES DE CHATGPT</h4>
      <div class="val" id="seen">sin verificar</div>
      <div class="note" id="settings-note">Lo que ve ISyMCP en el selector de modelo de ChatGPT. Para cambiarlo, sincroniza: se abre un Chrome con tu sesión, lo configuras a mano y lo cierras.</div>
      <div class="actions"><button class="btn" id="btn-verify" type="button">Verificar</button><button class="btn btn-go" id="btn-sync" type="button">Sincronizar ajustes</button><button class="btn btn-stop" id="btn-finish" type="button" hidden>Listo, guardar</button></div></div>
    <div class="row"><h4>CODEX ISyMCP</h4>
      <button class="switch" id="tools-switch" role="switch" aria-label="Permitir ejecución de tools para este chat" aria-checked="false" type="button" disabled><span></span><b>OFF</b></button>
      <label class="note" for="tools-session">Sesión local para tools</label><select id="tools-session" class="select" aria-label="Sesión local de tools" disabled></select>
      <div class="note" id="tools-note">Tools apagadas en cada chat nuevo. Al encenderlas, ChatGPT puede ejecutar comandos en la carpeta de la sesión elegida (sandbox local aislado). El token nunca pasa por esta página.</div></div>
    <div class="row"><h4>CONVERSACIÓN</h4><div class="val" id="convlink"><span class="muted">sin /c/ todavía</span></div>
      <div class="note">Se crea con el primer mensaje.</div></div>
    <div class="row"><h4>BRIDGE</h4><div class="val" id="bridgestate">—</div></div>
  </aside>
</div>`;
}

export const CHAT_SCRIPT = `
const md=(${renderMarkdown.toString()});
const CHAT_VIEWS=${JSON.stringify(CLIENT_CHAT_VIEWS)};
const CHAT_VIEW_PREFERENCE_KEY=${JSON.stringify(CHAT_VIEW_PREFERENCE_KEY)};
const DEFAULT_CHAT_VIEW=${JSON.stringify(DEFAULT_CHAT_VIEW)};
const normalizeChatView=(${normalizeChatView.toString()});
const readChatViewPreference=(${readChatViewPreference.toString()});
const projectPanelReceipt=(${projectPanelReceipt.toString()});
const projectSavedReceipts=(${projectSavedReceipts.toString()});
const receiptLegacyLabel=(${receiptLegacyLabel.toString()});
const projectPanelActivity=(${projectPanelActivity.toString()});
const projectPendingChatStatus=(${projectPendingChatStatus.toString()});
const createSerializedDraftWriter=(${createSerializedDraftWriter.toString()});
const draftAfterSend=(${draftAfterSend.toString()});
const restoreDraftState=(${restoreDraftState.toString()});
const draftsToPersistOnPageHide=(${draftsToPersistOnPageHide.toString()});
const $=(id)=>document.getElementById(id);
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
function initialView(){try{return readChatViewPreference(window.localStorage)}catch{return 'conversation'}}
const chat={list:[],current:null,data:null,draft:'',sessions:[],settings:{state:'idle',last:null,seen:null},pending:null,creating:null,view:initialView(),status:null,statusError:false,statusTimer:null,statusInFlight:false,lastAnnouncedPhase:null,draftStates:Object.create(null),draftTimers:new Map(),dirtyDrafts:new Map(),draftRevisions:Object.create(null),draftVersions:Object.create(null),preIdVersion:0,preIdDraft:{text:'',start:0,end:0},openSerial:0};
let drawerTrigger=null;
function syncDrawerA11y(){const mobile=matchMedia('(max-width: 1050px)').matches;if(!mobile)document.body.classList.remove('show-side','show-config');for(const [id,cls] of [['history-panel','show-side'],['config-panel','show-config']]){$(id).setAttribute('aria-hidden',String(mobile&&!document.body.classList.contains(cls)));document.querySelectorAll('[aria-controls="'+id+'"]').forEach(b=>b.setAttribute('aria-expanded',String(mobile&&document.body.classList.contains(cls))));}}
function closeDrawer(which,restore=true){const body=document.body;body.classList.remove(which==='history'?'show-side':'show-config');const panel=$(which==='history'?'history-panel':'config-panel');document.querySelectorAll('[aria-controls="'+panel.id+'"]').forEach(b=>b.setAttribute('aria-expanded','false'));syncDrawerA11y();if(!restore)drawerTrigger=null;else if(drawerTrigger&&drawerTrigger.isConnected){drawerTrigger.focus();drawerTrigger=null;}}
function focusDrawerTarget(id){const target=$(id);if(!target)return;const started=performance.now();const focus=()=>{if(!target.isConnected)return;if(getComputedStyle(target).visibility!=='hidden'||performance.now()-started>=240){target.focus();return;}requestAnimationFrame(focus);};requestAnimationFrame(focus);}
function openDrawer(which,trigger,focusId){const history=which==='history';const cls=history?'show-side':'show-config';const wasOpen=document.body.classList.contains(cls);const switchingConfigTarget=!history&&wasOpen&&drawerTrigger&&drawerTrigger!==trigger;document.body.classList.remove(history?'show-config':'show-side');document.body.classList.toggle(cls,switchingConfigTarget||!wasOpen);const panel=$(history?'history-panel':'config-panel');const opened=document.body.classList.contains(cls);drawerTrigger=opened?trigger:null;document.querySelectorAll('[aria-controls="'+panel.id+'"]').forEach(b=>b.setAttribute('aria-expanded',String(opened)));syncDrawerA11y();if(opened&&focusId)focusDrawerTarget(focusId);else if(!opened&&trigger)trigger.focus();}
window.addEventListener('resize',syncDrawerA11y);syncDrawerA11y();
document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(document.body.classList.contains('show-side'))closeDrawer('history');else if(document.body.classList.contains('show-config'))closeDrawer('config');}});
document.querySelectorAll('[data-close-drawer]').forEach(b=>b.addEventListener('click',()=>closeDrawer(b.closest('.side')?'history':'config')));
function syncRailSelection(){const status=location.hash.startsWith('#estado');document.querySelector('[data-nav="chat"]').setAttribute('aria-current',status?'false':'page');document.querySelector('[data-nav="activity"]').setAttribute('aria-current',status?'page':'false');}
window.addEventListener('hashchange',syncRailSelection);syncRailSelection();
window.addEventListener('hashchange',()=>{if(statusPollVisible())void pollStatus();else if(!chat.pending)stopStatusTimer();});
function setView(view){const safe=normalizeChatView(view);chat.view=safe;try{window.localStorage.setItem(CHAT_VIEW_PREFERENCE_KEY,safe)}catch{}
  document.querySelectorAll('[data-view]').forEach(b=>{const selected=b.dataset.view===safe;b.setAttribute('aria-selected',String(selected));b.setAttribute('tabindex',selected?'0':'-1');});
  document.querySelectorAll('[data-panel]').forEach(p=>p.hidden=p.dataset.panel!==safe);
  if(safe==='evidence')renderEvidence();if(safe==='activity'){renderActivity();void pollStatus();}else if(!chat.pending)stopStatusTimer();}
document.querySelectorAll('[data-view]').forEach((b,index,tabs)=>{b.addEventListener('click',()=>setView(b.dataset.view));b.addEventListener('keydown',event=>{if(event.key!=='ArrowRight'&&event.key!=='ArrowLeft')return;event.preventDefault();const next=tabs[(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];next.focus();setView(next.dataset.view);});});
document.querySelector('[data-nav="chat"]').onclick=event=>{if(location.hash!=='#chat')location.hash='#chat';if(matchMedia('(max-width: 1050px)').matches)openDrawer('history',event.currentTarget,'newchat');};
document.querySelector('[data-nav="sessions"]').onclick=event=>openDrawer('config',event.currentTarget,'tools-session');
document.querySelector('[data-nav="settings"]').onclick=event=>openDrawer('config',event.currentTarget,'btn-verify');
document.querySelector('[data-nav="activity"]').onclick=()=>{closeDrawer('history',false);closeDrawer('config',false);location.hash='#estado';};
document.querySelector('.rail-brand').addEventListener('click',()=>{closeDrawer('history',false);closeDrawer('config',false);});
try{chat.current=localStorage.getItem('isymcp.chat')}catch{}
const KIND={
  provider_blocked:['bad','Bloqueado por OpenAI','ChatGPT rechazó o bloqueó esta solicitud. Nada se ejecutó en tu máquina.'],
  session:['warn','Sesión de ChatGPT inactiva','Las cookies vencieron o faltan: reimporta la sesión (scripts/import-cookies.ts).'],
  browser:['bad','Chrome se cayó','El navegador headless falló y no se pudo recuperar el turno.'],
  capture:['warn','No se pudo leer la respuesta','ChatGPT no devolvió una respuesta legible, o la conversación no se pudo asociar.'],
  bridge:['bad','El bridge no completó el turno','Falló el bridge local mientras hablaba con ChatGPT.'],
  unavailable:['bad','ISyMCP no disponible','El bridge local no responde. Enciéndelo para chatear.'],
  tools_session:['warn','Sesión de tools no válida','La sesión elegida para las tools ya no existe o caducó. Elige otra en el panel derecho (o crea una con isymcp session mint).'],
};
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});let j=null;try{j=await r.json()}catch{}return {status:r.status,ok:r.ok,json:j};}
const writeDraft=createSerializedDraftWriter((id,draft,revision,keepalive=false)=>api('/api/chats/'+encodeURIComponent(id)+'/draft',{method:'POST',body:JSON.stringify({draft,revision}),keepalive}));
function captureDraft(id){const t=$('input');const state={text:t.value,start:t.selectionStart??t.value.length,end:t.selectionEnd??t.value.length};chat.draft=state.text;if(id)chat.draftStates[id]=state;else chat.preIdDraft=state;return state;}
function nextDraftSnapshot(id,draft){const revision=Math.max(Date.now(),(chat.draftRevisions[id]||0)+1);chat.draftRevisions[id]=revision;return {text:draft,revision};}
function persistDraftSnapshot(id,snapshot,keepalive=false){return writeDraft(id,snapshot.text,snapshot.revision,keepalive).then(result=>{const latest=chat.dirtyDrafts.get(id);if(result&&result.ok&&latest&&latest.revision===snapshot.revision)chat.dirtyDrafts.delete(id);return result;});}
function saveDraftSoon(id,draft,immediate=false){if(!id)return Promise.resolve();const snapshot=nextDraftSnapshot(id,draft);chat.dirtyDrafts.set(id,snapshot);const previous=chat.draftTimers.get(id);if(previous)clearTimeout(previous);chat.draftTimers.delete(id);if(immediate)return persistDraftSnapshot(id,snapshot);const timer=setTimeout(()=>{chat.draftTimers.delete(id);void persistDraftSnapshot(id,snapshot).catch(()=>undefined);},350);chat.draftTimers.set(id,timer);return Promise.resolve();}
function flushDraft(id,draft,keepalive=false){if(!id)return Promise.resolve();const snapshot=nextDraftSnapshot(id,draft);chat.dirtyDrafts.set(id,snapshot);const timer=chat.draftTimers.get(id);if(timer)clearTimeout(timer);chat.draftTimers.delete(id);return persistDraftSnapshot(id,snapshot,keepalive);}
function persistPagehideSnapshot(id,snapshot){return api('/api/chats/'+encodeURIComponent(id)+'/draft',{method:'POST',body:JSON.stringify({draft:snapshot.text,revision:snapshot.revision}),keepalive:true}).then(result=>{const latest=chat.dirtyDrafts.get(id);if(result&&result.ok&&latest&&latest.revision===snapshot.revision)chat.dirtyDrafts.delete(id);return result;});}
function displayDraft(state){const t=$('input');t.value=state.text;t.style.height='';t.style.height=Math.min(t.scrollHeight,200)+'px';try{t.setSelectionRange(state.start,state.end)}catch{}}
window.addEventListener('pagehide',()=>{let current=null;if(chat.current){const state=captureDraft(chat.current);const pending=chat.dirtyDrafts.get(chat.current);current=pending&&pending.text===state.text?pending:nextDraftSnapshot(chat.current,state.text);chat.dirtyDrafts.set(chat.current,current);}for(const [id,snapshot] of draftsToPersistOnPageHide(chat.current,current,chat.dirtyDrafts)){const timer=chat.draftTimers.get(id);if(timer)clearTimeout(timer);chat.draftTimers.delete(id);void persistPagehideSnapshot(id,snapshot).catch(()=>undefined);}});
function relTime(iso){const s=(Date.now()-Date.parse(iso))/1000;if(s<60)return 'ahora';if(s<3600)return Math.round(s/60)+' min';if(s<86400)return Math.round(s/3600)+' h';return Math.round(s/86400)+' d';}
function renderList(){const ul=$('chatlist');ul.replaceChildren();
  if(!chat.list.length){ul.appendChild(el('li','muted small','(sin chats)'));return;}
  for(const c of chat.list){const li=el('li');const b=el('button',c.id===chat.current?'on':'');b.appendChild(el('span','t',c.title));
    b.appendChild(el('span','s',(c.conversation_url?'':'nuevo · ')+relTime(c.updated_at)+(chat.pending&&chat.pending.chat===c.id?' · …':'')));
    b.setAttribute('aria-current',c.id===chat.current?'true':'false');b.setAttribute('aria-pressed',String(c.id===chat.current));b.onclick=()=>{openChat(c.id);closeDrawer('history');};li.appendChild(b);ul.appendChild(li);}}
async function loadList(){const r=await api('/api/chats');if(r.ok){const fresh=r.json.chats;
  // No perder un chat recien creado si esta respuesta salio antes de crearlo (carrera al cargar).
  for(const c of chat.list)if(!fresh.some(f=>f.id===c.id)&&c.id===chat.current)fresh.unshift(c);chat.list=fresh;renderList();}}
function scrollEnd(){const m=$('msgs');m.scrollTop=m.scrollHeight;}
function addCopy(root){root.querySelectorAll('pre').forEach(pre=>{const b=el('button','copy','copiar');b.type='button';b.onclick=()=>{navigator.clipboard?.writeText(pre.querySelector('code').textContent);b.textContent='copiado';setTimeout(()=>b.textContent='copiar',1200);};pre.appendChild(b);});}
function metaLine(m,url){const d=el('div','meta');d.appendChild(el('span','',settingsLabel()||'modelo default'));if(m&&m.ms!=null)d.appendChild(el('span','',(m.ms/1000).toFixed(1)+' s'));
  const u=(m&&m.url)||url;if(u){const a=el('a','', 'Abrir en ChatGPT ↗');a.href=u;a.target='_blank';a.rel='noreferrer';d.appendChild(a);}return d;}
function toolCardsNode(cards){const box=el('div','tools');for(const c of cards){const card=el('div','toolcard '+c.state);const th=el('div','th');th.appendChild(el('span','tn',c.tool));
  const st=c.state==='running'?'ejecutando…':[c.exit_code!=null?'exit '+c.exit_code:(c.state==='ok'?'ok':'falló'),c.duration_ms!=null?(c.duration_ms<1000?c.duration_ms+' ms':(c.duration_ms/1000).toFixed(1)+' s'):null].filter(Boolean).join(' · ');
  th.appendChild(el('span','ts',st));card.appendChild(th);if(c.summary)card.appendChild(el('code','',c.summary));if(c.error)card.appendChild(el('div','tools-none',c.error));box.appendChild(card);}return box;}
function toolsBlock(meta){if(!meta||!meta.tools_enabled)return null;if(meta.tools&&meta.tools.length)return toolCardsNode(meta.tools);return el('div','tools-none','tools activas · ninguna ejecución registrada en este turno');}
function renderMessage(m,url){const box=el('div','msg '+(m.role==='user'?'user':'assistant'));
  if(m.role==='user'){box.appendChild(el('div','bubble',m.text));return box;}
  if(m.role==='assistant'){
    box.appendChild(assistantOrigin());
    if(m.meta&&m.meta.thought){const d=el('details','thought-box');const s=el('summary','thought-summary','🧠 Razonamiento');d.appendChild(s);d.appendChild(el('div','thought-body',m.meta.thought));box.appendChild(d);}
    const tb=toolsBlock(m.meta);if(tb)box.appendChild(tb);const body=el('div','body');body.innerHTML=md(m.text);addCopy(body);box.appendChild(body);box.appendChild(metaLine(m.meta,url));return box;}
  {const tb=toolsBlock(m.meta);if(tb)box.appendChild(tb);}
  const kind=(m.meta&&m.meta.kind)||'bridge';const [tone,title,expl]=KIND[kind]||KIND.bridge;
  const card=el('div','errcard tone-'+tone);const h=el('div','h');h.appendChild(el('span','','⚠'));h.appendChild(el('span','',title));card.appendChild(h);
  card.appendChild(el('div','p',kind==='provider_blocked'?(m.text+' — '+expl):expl));
  const det=(m.meta&&m.meta.detail)||(kind!=='provider_blocked'?m.text:'');
  if(det){const d=el('details');d.appendChild(el('summary','','diagnóstico'));d.appendChild(el('pre','',det));card.appendChild(d);}
  if(kind==='unavailable'){const b=el('button','btn btn-go','Encender server');b.dataset.action='server-start';card.appendChild(b);}
  box.appendChild(card);if(m.meta&&m.meta.ms!=null)box.appendChild(metaLine({ms:m.meta.ms},null));return box;}
function assistantOrigin(){const label=el('div','assistant-origin');const img=document.createElement('img');img.src='/assets/openai-white-monoblossom.png';img.alt='OpenAI Blossom, avatar de la respuesta de ChatGPT';label.appendChild(img);label.appendChild(el('span','','ChatGPT'));return label;}
function renderEmpty(){const m=$('msgs');m.replaceChildren();const e=el('div','empty');e.appendChild(el('h2','','ISyMCP'));e.appendChild(el('p','','Escribe para empezar. Cada chat abre su propia conversación en chatgpt.com.'));m.appendChild(e);}
function renderConvLink(c){const box=$('convlink');box.replaceChildren();
  if(c&&c.conversation_url){const a=el('a','',c.conversation_url.replace('https://',''));a.href=c.conversation_url;a.target='_blank';a.rel='noreferrer';a.style.cssText='color:var(--ok);font:12px var(--mono);word-break:break-all';box.appendChild(a);}
  else box.appendChild(el('span','muted','sin /c/ todavía'));}
async function loadSessions(){const r=await api('/api/sessions').catch(()=>null);if(r&&r.ok){chat.sessions=r.json.sessions;chat.tunnel=r.json.tunnel;}}
function sessionLabel(x){const exp=x.expired?'caducada':(x.expiresAt?'caduca '+relTime(x.expiresAt).replace('ahora','pronto'):'sin caducidad');return (x.writable?'rw':'ro')+' · '+x.label+' · '+x.cwd+' · '+exp;}
function renderTools(c){const sw=$('tools-switch'),sel=$('tools-session'),note=$('tools-note');
  sw.disabled=!c;sel.disabled=!c;const on=!!(c&&c.tools_enabled);sw.setAttribute('aria-checked',String(on));sw.querySelector('b').textContent=on?'ON':'OFF';
  sel.replaceChildren();const ph=el('option','',chat.sessions.length?'elige una sesión…':'no hay sesiones — isymcp session mint --cwd <dir>');ph.value='';sel.appendChild(ph);
  for(const x of chat.sessions){const o=el('option','',sessionLabel(x));o.value=x.fp;o.disabled=x.expired;sel.appendChild(o);}
  sel.value=(c&&c.session_fp&&chat.sessions.some(x=>x.fp===c.session_fp))?c.session_fp:'';
  const chosen=chat.sessions.find(x=>x.fp===sel.value);
  note.textContent=!c?'Abre o crea un chat para configurar sus tools.':!on?'Tools apagadas en este chat. Al encenderlas, ChatGPT puede ejecutar comandos en la carpeta de la sesión elegida (sandbox local aislado). El token nunca pasa por esta página.'
    :(chat.tunnel!=='ready'?'⚠ El túnel MCP está detenido: ChatGPT no podrá llamar a las tools (Estado → Túnel ▶). ':'')+(chosen?(chosen.writable?'Lectura y ESCRITURA en ':'Solo lectura en ')+chosen.cwd+'. Cada turno usa un token desechable; ves aquí lo que de verdad se ejecutó.':'Elige una sesión.');}
async function saveTools(enabled,fp){const chatId=chat.current;if(!chatId)return;const r=await api('/api/chats/'+encodeURIComponent(chatId)+'/config',{method:'POST',body:JSON.stringify({tools_enabled:enabled,session_fp:fp||null})});
  if(chat.current!==chatId||chat.data?.id!==chatId)return;
  if(r.ok){chat.data={...chat.data,...r.json,session_fp:fp||null};renderTools(chat.data);renderEvidence();renderActivity();}else toast('✗ '+((r.json&&r.json.error&&r.json.error.message)||'no se pudo guardar'),'bad');renderTools(chat.data);}
$('tools-switch').onclick=async()=>{if(!chat.data)return;const on=!chat.data.tools_enabled;const fp=$('tools-session').value;
  if(on&&!fp){$('tools-session').focus();$('tools-note').textContent='Elige primero una sesión para las tools.';return;}await saveTools(on,fp);};
$('tools-session').onchange=async()=>{if(!chat.data)return;await saveTools(chat.data.tools_enabled,$('tools-session').value);};
function receipts(){return projectSavedReceipts(chat.data&&chat.data.messages,'all').receipts;}
function receiptNode(item,activity=false){const {index,card}=item;const wrap=el('article',(activity?'activity-card':'evidence-card')+' '+card.state);const heading=el('div','heading');heading.appendChild(el('span','',card.tool));heading.appendChild(el('span','',(card.state==='running'?'ejecutándose':card.state==='failed'?'falló':'completada')+(card.exit_code!=null?' · exit '+card.exit_code:'')));wrap.appendChild(heading);
  wrap.appendChild(el('div','summary',card.summary));if(card.error)wrap.appendChild(el('div','tools-none',card.error));if(card.duration_ms!=null)wrap.appendChild(el('div','meta','Duración registrada: '+card.duration_ms+' ms'));
  const legacy=receiptLegacyLabel(card);if(legacy)wrap.appendChild(el('div','receipt-legacy',legacy));
  const owner=el('a','receipt-owner','Ir al mensaje propietario');owner.href='#';owner.dataset.messageIndex=String(index);owner.addEventListener('click',event=>{event.preventDefault();setView('conversation');requestAnimationFrame(()=>document.getElementById('message-'+index)?.scrollIntoView({block:'center'}));});wrap.appendChild(owner);return wrap;}
function renderEvidence(){const box=$('evidence-list');if(!box)return;box.replaceChildren();if(!chat.current){box.appendChild(el('p','muted','Selecciona un chat para revisar sus comprobantes.'));return;}
  const result=projectSavedReceipts(chat.data&&chat.data.messages,$('evidence-filter').value);
  if(result.state==='none'){box.appendChild(el('p','muted','No hay comprobantes guardados para este chat. Los mensajes heredados sin meta.tools no permiten reconstruir ejecuciones.'));return;}
  if(result.state==='filtered'){box.appendChild(el('p','muted','No hay comprobantes que coincidan con este filtro.'));return;}for(const item of result.receipts)box.appendChild(receiptNode(item));}
$('evidence-filter').addEventListener('change',renderEvidence);
async function openChat(id,options={}){if(chat.current&&(chat.data||chat.draftStates[chat.current]))captureDraft(chat.current);else if(!chat.current)captureDraft(null);const serial=++chat.openSerial;chat.touched=true;chat.current=id;chat.data=null;chat.lastAnnouncedPhase=null;chat.draft='';$('input').value='';$('input').disabled=true;$('send').disabled=true;$('msgs').replaceChildren();renderEmpty();try{localStorage.setItem('isymcp.chat',id)}catch{}renderList();renderEvidence();renderActivity();renderConvLink(null);renderTools(null);
  const r=await api('/api/chats/'+encodeURIComponent(id));
  if(chat.current!==id||chat.openSerial!==serial)return;
  if(!r.ok){chat.current=null;chat.data=null;chat.draft='';$('input').value='';$('input').disabled=false;$('send').disabled=!!chat.pending;renderEmpty();renderConvLink(null);renderTools(null);renderEvidence();renderActivity();return;}
  chat.data=r.json;chat.draftRevisions[id]=Number.isSafeInteger(r.json.draft_revision)?r.json.draft_revision:0;chat.lastAnnouncedPhase=null;let draftState=chat.draftStates[id];if(options.transferScratch){draftState=chat.preIdDraft;chat.draftStates[id]=draftState;chat.preIdDraft={text:'',start:0,end:0};}if(!draftState){draftState=restoreDraftState(null,r.json.draft);chat.draftStates[id]=draftState;}chat.draft=draftState.text;displayDraft(draftState);$('input').disabled=false;$('send').disabled=!!chat.pending;if(options.transferScratch)void saveDraftSoon(id,draftState.text,true).catch(()=>undefined);const m=$('msgs');m.replaceChildren();
  if(!chat.data.messages.length)renderEmpty();
  chat.data.messages.forEach((msg,index)=>{const node=renderMessage(msg,chat.data.conversation_url);node.id='message-'+index;m.appendChild(node);});
  if(chat.pending&&chat.pending.chat===id)m.appendChild(chat.pending.node);
  renderConvLink(chat.data);await loadSessions();if(chat.current!==id||chat.openSerial!==serial)return;renderTools(chat.data);renderEvidence();renderActivity();scrollEnd();}
const PHASE={queued:'En cola',navigating:'Cambiando de conversación',thinking:'Pensando',idle:'Sin turno activo'};
function setBusy(b){$('send').disabled=b;$('hint').textContent=b?'esperando a ChatGPT… puedes ver otros chats mientras':'cada chat es su propia conversación en chatgpt.com';}
function renderBridgeState(){const b=$('bridgestate');b.replaceChildren();const ok=!chat.statusError&&!!chat.status;const label=chat.statusError?'● apagado':ok?'● en línea':'— sin verificar';const dot=el('span','',label);dot.style.color=chat.statusError?'var(--bad)':ok?'var(--ok)':'var(--mute)';b.appendChild(dot);
  if(chat.statusError){const btn=el('button','btn btn-go','Encender');btn.dataset.action='server-start';btn.style.marginLeft='8px';b.appendChild(btn);}}
function renderActivity(){const bridge=$('activity-bridge'),statusBox=$('activity-status'),items=$('activity-receipts');if(!bridge)return;bridge.replaceChildren();statusBox.replaceChildren();items.replaceChildren();
  const snapshot=projectPanelActivity(chat.status,chat.current,chat.statusError);
  if(snapshot.bridge==='unavailable'){bridge.appendChild(el('span','', 'Bridge no disponible · no se recibió un estado actual.'));bridge.style.color='var(--bad)';}
  else if(snapshot.bridge==='pending'){bridge.appendChild(el('span','', 'Estado del bridge pendiente de verificación.'));bridge.style.color='var(--mute)';}
  else{bridge.appendChild(el('span','', 'Bridge disponible · estado recibido ahora.'));bridge.style.color='var(--ok)';}
  if(snapshot.relation==='unknown')statusBox.appendChild(el('p','activity-state',snapshot.bridge==='unavailable'?'No se puede mostrar la fase ni la cola hasta que el bridge responda.':'Esperando el primer estado del bridge.'));
  else if(snapshot.relation==='other')statusBox.appendChild(el('p','activity-state','Otro chat activo · la fase y las herramientas globales pertenecen a ese chat y se ocultan aquí.'));
  else if(snapshot.relation==='selected'){statusBox.appendChild(el('p','activity-state','Este chat · '+(PHASE[snapshot.phase]||'Estado recibido')+(snapshot.since?' · desde '+new Date(snapshot.since).toLocaleTimeString():'')+'.'));if(snapshot.queued>0)statusBox.appendChild(el('p','activity-state','Turnos en espera del bridge (contador global): '+snapshot.queued+'.'));
    for(const card of snapshot.tools||[]){const live=el('article','activity-card '+card.state);const title=el('div','heading');title.appendChild(el('span','',card.tool));title.appendChild(el('span','',card.state==='running'?'ejecutándose':card.state==='failed'?'falló':'completada'));live.appendChild(title);live.appendChild(el('div','summary',card.summary));if(card.error)live.appendChild(el('div','tools-none',card.error));statusBox.appendChild(live);}}
  else if(snapshot.relation==='queued_unattributed')statusBox.appendChild(el('p','activity-state','Hay turnos en cola del bridge; no se informa aquí el chat propietario.'+(snapshot.queued>0?' Turnos en espera: '+snapshot.queued+'.':'')));
  else statusBox.appendChild(el('p','activity-state','No hay un turno activo identificado.'));
  const history=receipts();if(!history.length)items.appendChild(el('p','muted','Este chat no tiene comprobantes guardados.'));else for(const item of history)items.appendChild(receiptNode(item,true));}
function statusPollVisible(){return location.hash!=='#estado'&&chat.view==='activity';}
function stopStatusTimer(){if(chat.statusTimer){clearTimeout(chat.statusTimer);chat.statusTimer=null;}}
function scheduleStatusPoll(){stopStatusTimer();if(!chat.pending&&!statusPollVisible())return;chat.statusTimer=setTimeout(()=>{chat.statusTimer=null;void pollStatus()},chat.pending?600:10000);}
async function pollStatus(){if(chat.statusInFlight||(!chat.pending&&!statusPollVisible()))return;chat.statusInFlight=true;stopStatusTimer();
  try{const r=await api('/api/chat/status').catch(()=>null);chat.statusError=!r||!r.ok;chat.status=!chat.statusError?r.json:null;renderBridgeState();if(chat.view==='activity')renderActivity();if(!chat.statusError&&chat.pending&&typeof chat.pending.onStatus==='function')chat.pending.onStatus(chat.status);}
  finally{chat.statusInFlight=false;scheduleStatusPoll();}}
async function send(text,sentDraft,startingChat,startingVersion,startingScratchVersion){
  if(chat.pending)return;
  // Si "Nuevo chat" sigue creandose, esperarlo en vez de crear otro.
  if(chat.creating)await chat.creating;
  if(!chat.current){const r=await api('/api/chats',{method:'POST',body:'{}'});if(!r.ok){displayDraft({text:sentDraft,start:sentDraft.length,end:sentDraft.length});return;}chat.list.unshift(r.json);const typedAfterSubmit=chat.preIdVersion!==startingScratchVersion;await openChat(r.json.id,{transferScratch:typedAfterSubmit});if(typedAfterSubmit){const state=captureDraft(chat.current);chat.draftStates[chat.current]=state;void saveDraftSoon(chat.current,state.text,true).catch(()=>undefined);}}
  const id=chat.current;const m=$('msgs');if(m.querySelector('.empty'))m.replaceChildren();
  m.appendChild(renderMessage({role:'user',text}));
  const node=el('div','msg assistant');node.appendChild(assistantOrigin());const th=el('div','thinking');th.appendChild(el('i'));const label=el('span','','Enviando…');th.appendChild(label);node.appendChild(th);m.appendChild(node);scrollEnd();
  const t0=Date.now();const pending={chat:id,node,onStatus:null};chat.pending=pending;setBusy(true);renderList();
  let phase='queued';let shown='';let shownThought='';let liveBody=null;let liveTools=null;let liveThought=null;
  const tick=()=>{const secs=Math.round((Date.now()-t0)/1000);label.textContent=(shown?'Escribiendo':(shownThought?'Pensando':PHASE[phase]))+'… '+secs+' s';};
  pending.onStatus=(s)=>{tick();const update=projectPendingChatStatus(s,id);if(update.matchesChat){const next=update.phase||phase;if(next!==phase){phase=next;$('phase-live').textContent='Turno de este chat: '+(PHASE[phase]||phase)+'.';chat.lastAnnouncedPhase=phase;}
      // Texto en vivo: cada sondeo trae la respuesta COMPLETA hasta ahora (se reemplaza, no se concatena).
      if(update.tools){const nt=toolCardsNode(update.tools);if(liveTools)liveTools.replaceWith(nt);else node.insertBefore(nt,node.firstChild);liveTools=nt;}
      if(update.thought&&update.thought!==shownThought){shownThought=update.thought;
        if(!liveThought){liveThought=el('details','thought-box');liveThought.open=true;liveThought.appendChild(el('summary','thought-summary','🧠 Razonando…'));liveThought.appendChild(el('div','thought-body',shownThought));node.insertBefore(liveThought,liveBody||th);}
        else{const tb=liveThought.querySelector('.thought-body');if(tb)tb.textContent=shownThought;}}
      if(update.partial&&update.partial!==shown){shown=update.partial;
        if(!liveBody){liveBody=el('div','body live-body');node.insertBefore(liveBody,th);}
        const nearEnd=$('msgs').scrollHeight-$('msgs').scrollTop-$('msgs').clientHeight<80;
        liveBody.innerHTML=md(shown);if(nearEnd&&chat.current===id)scrollEnd();}
      tick();}};
  scheduleStatusPoll();void pollStatus();
  let r;try{r=await api('/api/chats/'+encodeURIComponent(id)+'/messages',{method:'POST',body:JSON.stringify({message:text})});}catch(e){r={status:0,ok:false,json:null};}
  const changed=startingChat===id?(chat.draftVersions[id]||0)!==startingVersion:chat.preIdVersion!==startingScratchVersion||(chat.draftVersions[id]||0)>0;
  const currentDraft=(chat.draftStates[id]&&chat.draftStates[id].text)||'';const nextDraft=draftAfterSend(sentDraft,currentDraft,changed,r.ok);
  chat.draftStates[id]={text:nextDraft,start:changed?(chat.draftStates[id]?.start??nextDraft.length):nextDraft.length,end:changed?(chat.draftStates[id]?.end??nextDraft.length):nextDraft.length};
  if(chat.current===id){chat.draft=nextDraft;displayDraft(chat.draftStates[id]);}
  await flushDraft(id,nextDraft).catch(()=>undefined);
  chat.pending=null;setBusy(false);scheduleStatusPoll();
  if(r.status===503||r.status===0){node.replaceWith(renderMessage({role:'error',text:(r.json&&r.json.error&&r.json.error.message)||'sin respuesta del bridge',meta:{kind:'unavailable'}}));}
  else if(!r.ok){node.replaceWith(renderMessage({role:'error',text:(r.json&&r.json.error&&r.json.error.message)||('HTTP '+r.status),meta:{kind:'bridge'}}));}
  await loadList();if(chat.current===id&&r.ok)await openChat(id);else if(chat.current===id)scrollEnd();}
$('composer').addEventListener('submit',(e)=>{e.preventDefault();const input=$('input'),sentDraft=input.value,t=sentDraft.trim();if(!t||chat.pending)return;const startingChat=chat.current,startingVersion=startingChat?(chat.draftVersions[startingChat]||0):0,startingScratchVersion=chat.preIdVersion;input.value='';chat.draft='';if(startingChat)chat.draftStates[startingChat]={text:'',start:0,end:0};else chat.preIdDraft={text:'',start:0,end:0};input.style.height='';send(t,sentDraft,startingChat,startingVersion,startingScratchVersion);});
$('input').addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('composer').requestSubmit();}});
$('input').addEventListener('input',()=>{const t=$('input');chat.draft=t.value;t.style.height='auto';t.style.height=Math.min(t.scrollHeight,200)+'px';const state=captureDraft(chat.current);if(chat.current){chat.draftVersions[chat.current]=(chat.draftVersions[chat.current]||0)+1;saveDraftSoon(chat.current,state.text);}else{chat.preIdVersion++;}});
 $('newchat').onclick=()=>{if(chat.creating)return chat.creating;const input=$('input'),sendButton=$('send'),previousChat=chat.current,inputWasDisabled=input.disabled,sendWasDisabled=sendButton.disabled;input.disabled=true;sendButton.disabled=true;chat.creating=(async()=>{try{const r=await api('/api/chats',{method:'POST',body:'{}'});if(r.ok){chat.list.unshift(r.json);await openChat(r.json.id,{transferScratch:!chat.current});closeDrawer('history',false);input.focus();}}finally{chat.creating=null;if(chat.current===previousChat){input.disabled=inputWasDisabled;sendButton.disabled=sendWasDisabled;}}})();return chat.creating;};
let lastShownResult=null;
function settingsLabel(){const v=chat.settings.seen;if(!v||(!v.model&&!v.effort))return '';return [v.model,v.effort].filter(Boolean).join(' · ');}
function renderSettings(){const seen=$('seen');const v=chat.settings.seen;
  seen.textContent=v&&(v.model||v.effort)?[v.model||'?',(v.effort||'?')+(v.effortPosition&&v.effortSteps?' ('+v.effortPosition+'/'+v.effortSteps+')':'')].join(' · '):(v?'no se pudo leer el selector':'sin verificar');
  const open=chat.settings.state!=='idle';$('btn-sync').hidden=open;$('btn-finish').hidden=chat.settings.state!=='open';$('btn-verify').disabled=open;
  const note=$('settings-note');
  if(chat.settings.state==='open')note.textContent='Chrome abierto: elige modelo y reasoning en chatgpt.com y cierra la ventana (o presiona "Listo, guardar"). Los mensajes esperan en cola mientras tanto.';
  else if(chat.settings.state==='saving')note.textContent='Guardando ajustes…';
  else if(chat.settings.last)note.textContent=(chat.settings.last.saved?'✓ ':'✗ ')+chat.settings.last.reason;}
async function pollSettings(){const r=await api('/api/settings').catch(()=>null);if(!r||!r.ok)return;const prev=chat.settings.state;chat.settings=r.json;renderSettings();
  // Tras guardar, verificar solo: asi se ve si el headless quedo sincronizado.
  if(prev!=='idle'&&chat.settings.state==='idle'&&chat.settings.last&&chat.settings.last.saved&&chat.settings.last.at!==lastShownResult){lastShownResult=chat.settings.last.at;verify();}}
async function verify(){const b=$('btn-verify');b.disabled=true;b.textContent='verificando…';const r=await api('/api/settings/verify',{method:'POST',body:'{}'}).catch(()=>null);
  b.disabled=false;b.textContent='Verificar';if(r&&r.ok){chat.settings=r.json;chat.settings.seen=r.json.seen;renderSettings();}else toast('✗ no se pudo verificar: '+((r&&r.json&&r.json.error&&r.json.error.message)||'bridge apagado'),'bad');}
$('btn-verify').onclick=verify;
$('btn-sync').onclick=async()=>{const r=await api('/api/settings/open',{method:'POST',body:'{}'}).catch(()=>null);
  if(r&&(r.status===202)){chat.settings=r.json;renderSettings();toast('Chrome abierto: configura ChatGPT y ciérralo','ok');}else toast('✗ '+((r&&r.json&&(r.json.reason||(r.json.error&&r.json.error.message)))||'bridge apagado'),'bad');};
$('btn-finish').onclick=async()=>{await api('/api/settings/finish',{method:'POST',body:'{}'}).catch(()=>null);pollSettings();};
setInterval(pollSettings,2000);
(async()=>{setView(chat.view);await loadList();if(!chat.touched){if(chat.current&&chat.list.some(c=>c.id===chat.current))await openChat(chat.current);else{chat.current=null;renderEmpty();await loadSessions();renderTools(null);renderEvidence();renderActivity();}}pollSettings();})();
`;
