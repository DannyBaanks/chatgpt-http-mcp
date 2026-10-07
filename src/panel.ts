// panel.ts — panel visual del bridge (estilo ISyCo Worlds).
//   isymcp panel [--port 8798]   ->  http://127.0.0.1:8798
// GET / -> pagina (pestanas Chat | Estado); GET /fragment -> solo el <main>
// del Estado (auto-refresco); GET /api/state -> JSON; POST /api/action ->
// acciones via isymcp; /api/chats* -> chat local (los turnos van al bridge).
// Todo es local: sin fuentes, scripts ni imagenes de internet.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isExpired, listUserSessions } from "./codex-sessions";
import { guardLocalRequest } from "./local-guard";
import { chatPath, createChat, listChats, loadChat, publicChat, saveChat } from "./chats";
import { CHAT_SCRIPT, CHAT_STYLE, renderChatView } from "./panel-chat";
import { apply as harnessApply, detect as harnessDetect, plan as harnessPlan, type HarnessAction } from "./harness";

function pgrep(pattern: string): boolean {
  const p = Bun.spawnSync(["pgrep", "-f", pattern], { stdout: "ignore", stderr: "ignore" });
  return (p.exitCode ?? 1) === 0;
}

export interface PanelSession {
  label: string;
  fp: string;
  writable: boolean;
  cwd?: string;
  expiresAt?: string | null;
  expired?: boolean;
}

/** Ultima prueba de soak encontrada en docs/evidence (la mas reciente). */
export interface PanelSoak {
  file: string;
  ts: string;
  ok: number;
  n: number;
  turns: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface PanelState {
  ts: string;
  server: "up" | "down";
  serverPort: string;
  tunnel: "ready" | "stopped";
  mcp: "up" | "down";
  browser: "ok" | "page-crashed";
  conversation: string | null;
  sessions: PanelSession[];
  lastErrors: string[];
  lastSoak?: PanelSoak | null;
}

const ROOT = join(import.meta.dir, "..");

export function readLastSoak(dir = join(ROOT, "docs", "evidence")): PanelSoak | null {
  try {
    const files = readdirSync(dir)
      .filter((name) => /^soak.*\.json$/.test(name))
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const newest = files[0];
    if (!newest) return null;
    const data = JSON.parse(readFileSync(join(dir, newest.name), "utf8")) as {
      ts?: string; ok?: number; n?: number;
      results?: Array<{ i?: number; name?: string; ok?: boolean; reply?: string; http?: string }>;
    };
    const turns = (data.results ?? []).map((r, index) => ({
      name: r.name ?? `turno ${r.i ?? index + 1}`,
      ok: r.ok === true,
      detail: String(r.reply ?? r.http ?? "").slice(0, 140),
    }));
    return { file: newest.name, ts: data.ts ?? "", ok: data.ok ?? turns.filter((t) => t.ok).length, n: data.n ?? turns.length, turns };
  } catch {
    return null;
  }
}

export async function buildPanelState(bridgePort = "8791"): Promise<PanelState> {
  let server: "up" | "down" = "down";
  try {
    const r = await fetch(`http://127.0.0.1:${bridgePort}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) server = "up";
  } catch {
    /* down */
  }
  const home = process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http");
  let conversation: string | null = null;
  try {
    conversation = (JSON.parse(readFileSync(join(home, "sessions", "default.json"), "utf8")) as { conversationUrl?: string | null }).conversationUrl ?? null;
  } catch {
    /* sin sesion */
  }
  const lastErrors: string[] = [];
  try {
    const log = join(home, "run", "server.log");
    if (existsSync(log)) {
      lastErrors.push(...readFileSync(log, "utf8").split("\n").filter((l) => l.includes("FAILED")).slice(-5));
    }
  } catch {
    /* sin log */
  }
  const browserCrashed = lastErrors.some((l) => /Page crashed|Target crashed/.test(l));
  let sessions: PanelSession[] = [];
  try {
    sessions = listUserSessions().map((s) => ({
      label: s.label, fp: s.fp, writable: s.writable, cwd: s.cwd,
      expiresAt: s.expiresAt ?? null, expired: isExpired(s),
    }));
  } catch {
    /* registro ilegible: se muestra vacio, el CLI da el error */
  }
  return {
    ts: new Date().toISOString(),
    server,
    serverPort: bridgePort,
    tunnel: pgrep("tunnel-client run") ? "ready" : "stopped",
    mcp: pgrep("mcp/main.ts --contract native --broker") ? "up" : "down",
    browser: browserCrashed ? "page-crashed" : "ok",
    conversation,
    sessions,
    lastErrors,
    lastSoak: readLastSoak(),
  };
}

/** Todo lo que entra al HTML viene de logs, URLs o labels: se escapa. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Tone = "ok" | "warn" | "bad" | "idle";

function tile(opts: { title: string; tone: Tone; state: string; detail: string; actions?: string }): string {
  return `<section class="tile tone-${opts.tone}">
  <header><span class="lamp"></span><h2>${opts.title}</h2></header>
  <div class="state">${escapeHtml(opts.state)}</div>
  <div class="detail">${opts.detail}</div>
  ${opts.actions ? `<div class="actions">${opts.actions}</div>` : ""}
</section>`;
}

function button(action: string, label: string, kind: "go" | "stop" | "plain" = "plain"): string {
  return `<button class="btn btn-${kind}" data-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`;
}

function relativeExpiry(s: PanelSession, now: number): { text: string; tone: Tone } {
  if (s.expired) return { text: "caducada", tone: "bad" };
  if (!s.expiresAt) return { text: "sin caducidad", tone: "warn" };
  const hours = (Date.parse(s.expiresAt) - now) / 3_600_000;
  if (hours < 24) return { text: `caduca en ${Math.max(1, Math.round(hours))} h`, tone: "warn" };
  return { text: `caduca en ${Math.round(hours / 24)} d`, tone: "ok" };
}

/** El <main> del panel: lo re-pide el navegador cada pocos segundos. */
export function renderMain(state: PanelState): string {
  const now = Date.parse(state.ts) || Date.now();
  const checks = [state.server === "up", state.tunnel === "ready", state.mcp === "up", state.browser === "ok"];
  const down = checks.filter((ok) => !ok).length;
  const health = down === 0
    ? `<span class="pill tone-ok">todo en linea</span>`
    : `<span class="pill tone-${down >= 3 ? "bad" : "warn"}">${down} de 4 sin servicio</span>`;

  const tiles = [
    tile({
      title: "SERVER", tone: state.server === "up" ? "ok" : "bad",
      state: state.server === "up" ? "en linea" : "apagado",
      detail: `http://127.0.0.1:${escapeHtml(state.serverPort)}`,
      actions: button("server-start", "Encender", "go") + button("server-stop", "Apagar", "stop"),
    }),
    tile({
      title: "TUNEL", tone: state.tunnel === "ready" ? "ok" : "bad",
      state: state.tunnel === "ready" ? "conectado" : "detenido",
      detail: "tunnel-client → ChatGPT",
      actions: button("tunnel-connect", "Conectar", "go") + button("tunnel-stop", "Detener", "stop"),
    }),
    tile({
      title: "MCP STDIO", tone: state.mcp === "up" ? "ok" : "bad",
      state: state.mcp === "up" ? "escuchando" : "caido",
      detail: "Codex ISyMCP · sandbox bwrap",
    }),
    tile({
      title: "BROWSER", tone: state.browser === "ok" ? "ok" : "bad",
      state: state.browser === "ok" ? "sano" : "pagina caida",
      detail: state.browser === "ok" ? "Chrome headless" : "el reviver relanza en el proximo turno",
    }),
  ].join("\n");

  const conversation = state.conversation
    ? `<a class="conv" href="${escapeHtml(state.conversation)}" target="_blank" rel="noreferrer">${escapeHtml(state.conversation.replace(/^https?:\/\//, ""))}</a>`
    : `<p class="muted">sin conversacion todavia — el primer turno la guarda</p>`;

  const soak = state.lastSoak;
  const soakBody = soak
    ? `<div class="score"><span class="big">${soak.ok}</span><span class="of">/ ${soak.n}</span>
         <span class="pill tone-${soak.ok === soak.n ? "ok" : soak.ok >= soak.n * 0.9 ? "warn" : "bad"}">${soak.ok === soak.n ? "limpio" : `${soak.n - soak.ok} fallo${soak.n - soak.ok === 1 ? "" : "s"}`}</span></div>
       <div class="bar"><span style="width:${soak.n ? Math.round((soak.ok / soak.n) * 100) : 0}%"></span></div>
       <ol class="turns">${soak.turns.slice(0, 100).map((t) =>
         `<li class="${t.ok ? "t-ok" : "t-bad"}" title="${escapeHtml(`${t.name}${t.ok ? "" : ` — ${t.detail}`}`)}"><span>${escapeHtml(t.name)}</span></li>`).join("")}</ol>
       <p class="muted small">${escapeHtml(soak.file)}${soak.ts ? ` · ${escapeHtml(soak.ts.replace("T", " ").slice(0, 16))}` : ""}</p>`
    : `<p class="muted">sin pruebas aun — <code>bun run scripts/soak-tools.ts</code></p>`;

  const sessionRows = state.sessions.length
    ? state.sessions.map((s) => {
        const exp = relativeExpiry(s, now);
        return `<tr>
          <td><span class="badge ${s.writable ? "rw" : "ro"}">${s.writable ? "rw" : "ro"}</span></td>
          <td>${escapeHtml(s.label)}<div class="muted small">${escapeHtml(s.cwd ?? "")}</div></td>
          <td><code>${escapeHtml(s.fp)}</code></td>
          <td><span class="pill tone-${exp.tone}">${escapeHtml(exp.text)}</span></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" class="muted">(ninguna) — <code>isymcp session mint --cwd &lt;dir&gt;</code></td></tr>`;

  const errors = state.lastErrors.length
    ? state.lastErrors.map((e) => `<div class="logline">${escapeHtml(e.slice(0, 220))}</div>`).join("")
    : `<div class="logline muted">sin errores recientes ✓</div>`;

  return `<main id="main" data-ts="${escapeHtml(state.ts)}">
<div class="topline">${health}<span class="muted small">actualizado ${escapeHtml(state.ts.slice(11, 19))} UTC</span></div>
<div class="tiles">${tiles}</div>
<div class="grid">
  <section class="card">
    <h3>ULTIMA PRUEBA</h3>
    ${soakBody}
  </section>
  <section class="card">
    <h3>CONVERSACION</h3>
    ${conversation}
    <h3 class="gap">SESIONES MCP <span class="muted small">${state.sessions.length}</span></h3>
    <table class="sessions"><tbody>${sessionRows}</tbody></table>
    <div class="actions">${button("session-list", "Listar en el CLI")}</div>
  </section>
</div>
<section class="card log">
  <h3>ULTIMOS ERRORES <span class="muted small">· ultimas 5 lineas FAILED de server.log (pueden ser viejas)</span></h3>
  ${errors}
</section>
</main>`;
}

const STYLE = `
:root{--bg:#090b0a;--panel:#101412;--line:#1d2420;--ink:#d9e4dc;--mute:#6f8076;--ok:#7cff9b;--warn:#ffcc66;--bad:#ff6b6b;--idle:#5b6b62;
--mono:"JetBrains Mono","Fira Code",ui-monospace,SFMono-Regular,Menlo,monospace;--sans:Inter,"Segoe UI",system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 var(--sans);
background-image:linear-gradient(rgba(124,255,155,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(124,255,155,.035) 1px,transparent 1px);background-size:28px 28px}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 48px}
.brand{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.brand h1{margin:0;font:700 26px/1 var(--mono);letter-spacing:.12em;color:var(--ok);text-shadow:0 0 18px rgba(124,255,155,.35)}
.brand .sub{color:var(--mute);font:12px var(--mono);letter-spacing:.08em}
.live{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--mute);font:12px var(--mono)}
.live i{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok);animation:pulse 2s infinite}
.live.stale i{background:var(--warn);box-shadow:0 0 10px var(--warn);animation:none}
@keyframes pulse{50%{opacity:.35}}
.topline{display:flex;align-items:center;gap:12px;margin:22px 0 14px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}
.tile{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 16px 14px;overflow:hidden}
.tile::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:var(--c)}
.tile header{display:flex;align-items:center;gap:8px}
.tile h2{margin:0;font:600 11px var(--mono);letter-spacing:.16em;color:var(--mute)}
.lamp{width:10px;height:10px;border-radius:50%;background:var(--c);box-shadow:0 0 12px var(--c)}
.tile .state{margin-top:10px;font:600 22px/1.1 var(--mono);color:var(--c)}
.tile .detail{margin-top:4px;color:var(--mute);font:12px var(--mono);word-break:break-all}
.tone-ok{--c:var(--ok)}.tone-warn{--c:var(--warn)}.tone-bad{--c:var(--bad)}.tone-idle{--c:var(--idle)}
.grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px;margin-top:14px}
.grid>*,.tiles>*{min-width:0}
@media (max-width:820px){.grid{grid-template-columns:minmax(0,1fr)}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.card h3{margin:0 0 12px;font:600 11px var(--mono);letter-spacing:.16em;color:var(--mute)}
.card h3.gap{margin-top:20px}
.log{margin-top:14px}
.logline{font:12px/1.6 var(--mono);color:#ffb3b3;border-left:2px solid var(--bad);padding:2px 0 2px 10px;margin:4px 0;word-break:break-all}
.logline.muted{color:var(--mute);border-color:var(--line)}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font:600 11px var(--mono);letter-spacing:.04em;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);border:1px solid color-mix(in srgb,var(--c) 35%,transparent)}
.muted{color:var(--mute)}.small{font-size:11px}
code{font:12px var(--mono);color:#b9c9bf;background:#0b0f0d;border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.conv{display:block;font:12px var(--mono);color:var(--ok);word-break:break-all;text-decoration:none;padding:10px 12px;border:1px dashed var(--line);border-radius:10px}
.conv:hover{border-color:var(--ok)}
.score{display:flex;align-items:baseline;gap:10px}
.score .big{font:700 46px/1 var(--mono);color:var(--ok)}
.score .of{font:600 20px var(--mono);color:var(--mute)}
.bar{height:6px;border-radius:6px;background:#1a211d;margin:12px 0 14px;overflow:hidden}
.bar span{display:block;height:100%;background:linear-gradient(90deg,var(--ok),#3ddc84)}
.turns{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:6px}
.turns li{font:11px var(--mono);padding:6px 8px;border-radius:8px;border:1px solid var(--line);display:flex;gap:6px;align-items:center;white-space:nowrap;overflow:hidden}
.turns li span{overflow:hidden;text-overflow:ellipsis}
.turns li::before{content:"";flex:none;width:7px;height:7px;border-radius:50%}
.t-ok::before{background:var(--ok)}.t-bad{border-color:color-mix(in srgb,var(--bad) 50%,transparent)!important;color:#ffb3b3}.t-bad::before{background:var(--bad)}
.sessions{width:100%;border-collapse:collapse}
.sessions{table-layout:fixed}
.sessions td{padding:8px 6px;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.sessions td:first-child{width:42px}.sessions td:nth-child(3){width:118px}.sessions td:last-child{width:132px;text-align:right}
@media (max-width:520px){.sessions td:nth-child(3){display:none}}
.badge{font:700 10px var(--mono);padding:2px 7px;border-radius:6px;letter-spacing:.08em}
.badge.rw{color:#1b0f00;background:var(--warn)}.badge.ro{color:#04140a;background:var(--ok)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.btn{font:600 12px var(--mono);letter-spacing:.04em;color:var(--ink);background:#151b18;border:1px solid var(--line);border-radius:9px;padding:7px 12px;cursor:pointer;transition:border-color .15s,transform .05s}
.btn:hover{border-color:var(--mute)}.btn:active{transform:translateY(1px)}
.btn-go:hover{border-color:var(--ok);color:var(--ok)}.btn-stop:hover{border-color:var(--bad);color:var(--bad)}
.btn[disabled]{opacity:.5;cursor:progress}
.toasts{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:9;max-width:min(440px,calc(100vw - 36px))}
.toast{background:#121815;border:1px solid var(--line);border-left:3px solid var(--c);border-radius:10px;padding:10px 12px;font:12px/1.5 var(--mono);white-space:pre-wrap;box-shadow:0 10px 30px rgba(0,0,0,.45);animation:in .18s ease-out}
@keyframes in{from{opacity:0;transform:translateY(6px)}}
footer{margin-top:22px;color:var(--mute);font:11px var(--mono);text-align:center}
`;

const SCRIPT = `
const toasts=document.querySelector('.toasts');
function toast(text,tone){const el=document.createElement('div');el.className='toast tone-'+tone;el.textContent=text;toasts.appendChild(el);setTimeout(()=>el.remove(),7000);}
async function refresh(){const live=document.querySelector('.live');try{const r=await fetch('/fragment',{cache:'no-store'});if(!r.ok)throw 0;const html=await r.text();const tpl=document.createElement('template');tpl.innerHTML=html.trim();document.getElementById('main').replaceWith(tpl.content.firstElementChild);live.classList.remove('stale');live.lastChild.textContent=' en vivo';}catch{live.classList.add('stale');live.lastChild.textContent=' sin conexion';}}
document.addEventListener('click',async(ev)=>{const b=ev.target.closest('[data-action]');if(!b)return;const a=b.dataset.action;b.disabled=true;const old=b.textContent;b.textContent='…';
try{const r=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:a})});const j=await r.json();toast((j.ok?'✓ ':'✗ ')+a+'\\n'+(j.out||'').slice(-600),j.ok?'ok':'bad');}
catch(e){toast('✗ '+a+'\\n'+e,'bad');}finally{b.disabled=false;b.textContent=old;refresh();}});
setInterval(()=>{if(!document.body.classList.contains('tab-chat'))refresh();},4000);
`;

// Tarjeta HARNESSES (pestana Estado): detectar -> plan (comandos exactos) ->
// confirmar -> aplicar -> resultado verificado por la propia herramienta.
const HARNESS_SCRIPT = `
const H={list:[]};
const hEl=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e;};
async function hApi(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});let j=null;try{j=await r.json()}catch{}return {ok:r.ok,json:j};}
function hSelected(){return Array.from(document.querySelectorAll('.hrow input:checked')).map(i=>i.value);}
function hRender(){const box=document.getElementById('harness-list');box.replaceChildren();box.classList.remove('muted');
  for(const h of H.list){const row=hEl('label','hrow');const cb=hEl('input');cb.type='checkbox';cb.value=h.id;cb.disabled=!h.present||!h.supported;row.appendChild(cb);
    row.appendChild(hEl('span','hid',h.id));row.appendChild(hEl('span','muted small',h.label));
    const tone=!h.present?'idle':!h.supported?'idle':h.installed===true?'ok':h.installed===false?'warn':'idle';
    const txt=!h.present?'no instalado':!h.supported?'detectado · aún no soportado':h.installed===true?'isymcp-chatgpt ✓':h.installed===false?'sin isymcp-chatgpt':'estado desconocido';
    const st=hEl('span','hst');const pill=hEl('span','pill tone-'+tone,txt);if(h.pending)pill.title=h.pending;st.appendChild(pill);row.appendChild(st);box.appendChild(row);}
  const any=H.list.some(h=>h.present&&h.supported);document.getElementById('harness-plan-install').disabled=!any;document.getElementById('harness-plan-remove').disabled=!any;}
async function hDetect(){const b=document.getElementById('harness-detect');b.disabled=true;b.textContent='detectando…';const r=await hApi('/api/harness');b.disabled=false;b.textContent='Detectar';
  if(r.ok){H.list=r.json.harnesses;hRender();}else toast('✗ no se pudo detectar','bad');}
async function hPlan(action){const ids=hSelected();const box=document.getElementById('harness-plan');if(!ids.length){toast('Marca al menos un harness','warn');return;}
  const r=await hApi('/api/harness/plan',{action,ids});if(!r.ok){toast('✗ '+((r.json&&r.json.error&&r.json.error.message)||'error'),'bad');return;}
  box.replaceChildren();box.className='planbox';box.hidden=false;box.appendChild(hEl('div','',(action==='install'?'Se instalará':'Se quitará')+' isymcp-chatgpt con estos comandos exactos (sin shell):'));
  for(const s of r.json.steps)box.appendChild(hEl('pre','',s.id+': '+(s.argv?s.argv.join(' '):'(nada) '+s.reason)));
  const runnable=r.json.steps.filter(s=>s.argv).map(s=>s.id);const act=hEl('div','actions');
  const ok=hEl('button','btn '+(action==='install'?'btn-go':'btn-stop'),runnable.length?'Confirmar y aplicar':'Nada que aplicar');ok.type='button';ok.disabled=!runnable.length;
  const cancel=hEl('button','btn','Cancelar');cancel.type='button';cancel.onclick=()=>{box.hidden=true;};
  ok.onclick=async()=>{ok.disabled=true;ok.textContent='aplicando…';const a=await hApi('/api/harness/apply',{action,ids:runnable,confirm:true});
    box.replaceChildren();if(!a.ok){box.appendChild(hEl('div','',(a.json&&a.json.error&&a.json.error.message)||'error'));return;}
    for(const x of a.json.results)box.appendChild(hEl('pre','',(x.ran?(x.ok?'✓ ':'✗ '):'– ')+x.id+(x.ran?' · verificado='+x.verified:'')+' · '+x.detail));hDetect();};
  act.appendChild(ok);act.appendChild(cancel);box.appendChild(act);}
document.getElementById('harness-detect').onclick=hDetect;
document.getElementById('harness-plan-install').onclick=()=>hPlan('install');
document.getElementById('harness-plan-remove').onclick=()=>hPlan('uninstall');
`;

const SHELL_STYLE = `
.harness{margin-top:14px}
.hrow{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--line);font:13px var(--sans)}
.hrow input{accent-color:#7cff9b}.hrow .hid{font:600 12px var(--mono);min-width:90px}.hrow .hst{margin-left:auto;text-align:right}
.planbox{margin-top:12px;border:1px dashed var(--line);border-radius:10px;padding:12px}
.planbox pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px var(--mono);margin:6px 0;color:#cfe3d5}
.top{position:sticky;top:0;z-index:6;height:57px;display:flex;align-items:center;gap:14px;padding:0 16px;background:rgba(9,11,10,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.top .logo{font:700 16px var(--mono);letter-spacing:.12em;color:var(--ok)}
.tabs{display:flex;gap:4px;margin-left:8px}
.tabs a{font:600 13px var(--sans);color:var(--mute);text-decoration:none;padding:7px 12px;border-radius:8px}
.tabs a.on{color:var(--ink);background:#151b18}
.top .live{margin-left:auto}
.drawer-btn{background:none;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:5px 9px;font:13px var(--mono);cursor:pointer}
body.tab-chat{overflow:hidden}
body:not(.tab-chat) #view-chat,body.tab-chat #view-estado{display:none}
@media (max-width:520px){.top{gap:8px;padding:0 10px}.top .logo{font-size:14px}.tabs{margin-left:0}.tabs a{padding:6px 8px}.live span.lbl{display:none}}
`;

export function renderPanel(state: PanelState): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ISyMCP</title><style>${STYLE}${SHELL_STYLE}${CHAT_STYLE}</style></head>
<body class="tab-chat">
<header class="top">
  <button class="drawer-btn" id="btn-side" title="Chats">☰</button>
  <span class="logo">ISyMCP</span>
  <nav class="tabs"><a href="#chat" data-tab="chat" class="on">Chat</a><a href="#estado" data-tab="estado">Estado</a></nav>
  <span class="live"><i></i><span class="lbl"> en vivo</span></span>
  <button class="drawer-btn" id="btn-config" title="Configuración">⚙</button>
</header>
<div id="view-chat">${renderChatView()}</div>
<div id="view-estado"><div class="wrap">
<div class="brand"><h1>ISyMCP PANEL</h1><span class="sub">chatgpt-http-mcp · bridge local</span></div>
${renderMain(state)}
<section class="card harness" id="harness-card">
  <h3>HARNESSES · MCP isymcp-chatgpt</h3>
  <p class="muted small">Instala en tus otras CLIs/TUIs de agentes (Claude Code, Codex, Qwen, Gemini, Grok…) la herramienta <code>chatgpt_ask</code>: consultan a tu ChatGPT web por el bridge. Nada se escribe sin tu confirmación; después se verifica con la propia herramienta.</p>
  <div id="harness-list" class="muted small">Pulsa «Detectar».</div>
  <div class="actions"><button class="btn" id="harness-detect" type="button">Detectar</button><button class="btn btn-go" id="harness-plan-install" type="button" disabled>Instalar seleccionados…</button><button class="btn btn-stop" id="harness-plan-remove" type="button" disabled>Quitar seleccionados…</button></div>
  <div id="harness-plan" hidden></div>
</section>
<footer>127.0.0.1 only · Host/Origin protegidos · <code>isymcp panel</code></footer>
</div></div>
<div class="toasts"></div>
<script>${SCRIPT}
function showTab(){const t=location.hash.startsWith('#estado')?'estado':'chat';document.body.classList.toggle('tab-chat',t==='chat');
document.querySelectorAll('.tabs a').forEach(a=>a.classList.toggle('on',a.dataset.tab===t));if(t==='estado')refresh();}
window.addEventListener('hashchange',showTab);showTab();
document.getElementById('btn-side').onclick=()=>{document.body.classList.toggle('show-side');document.body.classList.remove('show-config');};
document.getElementById('btn-config').onclick=()=>{document.body.classList.toggle('show-config');document.body.classList.remove('show-side');};
${CHAT_SCRIPT}
${HARNESS_SCRIPT}</script></body></html>`;
}

const ACTIONS: Record<string, string[]> = {
  "server-start": ["server", "start"],
  "server-stop": ["server", "stop"],
  "tunnel-connect": ["tunnel", "connect"],
  "tunnel-stop": ["tunnel", "stop"],
  "session-list": ["session", "list"],
};

export function runPanelAction(action: string): { ok: boolean; out: string } {
  const args = ACTIONS[action];
  if (!args) return { ok: false, out: `accion desconocida: ${action}` };
  const proc = Bun.spawnSync(["bun", "run", join(ROOT, "src", "isymcp.ts"), ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    env: process.env,
  });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim().slice(-1500);
  return { ok: (proc.exitCode ?? 1) === 0, out: out || `exit ${proc.exitCode}` };
}

export function startPanel(port = 8798, bridgePort = process.env.CODEX_WEB_HTTP_PORT ?? "8791") {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      // Host/Origin loopback + JSON en POST: sin esto cualquier pagina web
      // podia disparar acciones (CSRF) o leer /api/state (DNS rebinding).
      const denied = guardLocalRequest(req, { requireJsonBody: true });
      if (denied) return denied;
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/chat")) return handleChatApi(req, url, bridgePort);
      if (url.pathname.startsWith("/api/settings")) return handleSettingsApi(req, url, bridgePort);
      if (url.pathname === "/api/sessions" && req.method === "GET") return Response.json(publicSessions());
      if (url.pathname.startsWith("/api/harness")) return handleHarnessApi(req, url);
      if (url.pathname === "/api/action" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { action?: string };
        return Response.json(runPanelAction(String(body.action ?? "")));
      }
      const state = await buildPanelState(bridgePort);
      if (url.pathname === "/api/state") return Response.json(state);
      const html = url.pathname === "/fragment" ? renderMain(state) : renderPanel(state);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    },
  });
  return server;
}

function apiError(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

/**
 * API del chat local. El navegador solo manda chat_id + texto; nunca una URL
 * /c/ ni tokens. Los turnos se reenvian al bridge (donde vive Chrome); el
 * listado y la creacion se resuelven aqui contra el registro privado.
 */
export async function handleChatApi(req: Request, url: URL, bridgePort: string): Promise<Response> {
  const bridge = `http://127.0.0.1:${bridgePort}`;
  if (url.pathname === "/api/chat/status" && req.method === "GET") {
    try {
      const r = await fetch(`${bridge}/isymcp/chat/status`, { signal: AbortSignal.timeout(1500) });
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
    } catch {
      return apiError(503, "bridge_unavailable", "el bridge local no responde");
    }
  }
  if (url.pathname === "/api/chats") {
    if (req.method === "GET") return Response.json({ chats: listChats().map((c) => publicChat(c, false)) });
    if (req.method === "POST") return Response.json(publicChat(createChat(), false), { status: 201 });
    return apiError(405, "method_not_allowed", "GET o POST");
  }
  const m = /^\/api\/chats\/([^/]+)(\/messages|\/config)?$/.exec(url.pathname);
  if (!m) return apiError(404, "not_found", "ruta desconocida");
  const id = decodeURIComponent(m[1]!);
  if (!chatPath(id)) return apiError(400, "chat_bad_id", "chat_id invalido");
  const chat = loadChat(id);
  if (!chat) return apiError(404, "chat_not_found", "chat desconocido");
  if (!m[2]) {
    if (req.method !== "GET") return apiError(405, "method_not_allowed", "GET");
    return Response.json(publicChat(chat, true));
  }
  if (m[2] === "/config") {
    if (req.method !== "POST") return apiError(405, "method_not_allowed", "POST");
    const body = (await req.json().catch(() => null)) as { tools_enabled?: unknown; session_fp?: unknown } | null;
    if (!body || typeof body.tools_enabled !== "boolean") return apiError(400, "chat_bad_request", "se espera {tools_enabled, session_fp}");
    const fp = typeof body.session_fp === "string" ? body.session_fp : null;
    if (body.tools_enabled) {
      // Solo sesiones reales del usuario, vigentes; el navegador nunca ve el token.
      const session = fp ? listUserSessions().find((x) => x.fp === fp) : undefined;
      if (!session) return apiError(400, "tools_session_unknown", "elige una sesion existente");
      if (isExpired(session)) return apiError(400, "tools_session_expired", "esa sesion caduco; crea otra con isymcp session mint");
    }
    chat.tools_enabled = body.tools_enabled;
    chat.session_fp = body.tools_enabled ? fp : chat.session_fp && listUserSessions().some((x) => x.fp === chat.session_fp) ? chat.session_fp : null;
    chat.updated_at = new Date().toISOString();
    saveChat(chat);
    return Response.json(publicChat(chat, false));
  }
  if (req.method !== "POST") return apiError(405, "method_not_allowed", "POST");
  const body = (await req.json().catch(() => null)) as { message?: unknown } | null;
  if (!body || typeof body.message !== "string") return apiError(400, "chat_bad_request", "se espera {message}");
  // Solo se reenvian chat_id + message: aunque el navegador mande mas campos
  // (p. ej. una URL), no llegan al bridge.
  try {
    const r = await fetch(`${bridge}/isymcp/chat/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: id, message: body.message }),
      signal: AbortSignal.timeout(300_000),
    });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch (error) {
    return apiError(503, "bridge_unavailable", `el bridge local no responde (${bridge}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Proxy de "Sincronizar ajustes" al bridge (que es quien maneja Chrome). */
export async function handleSettingsApi(req: Request, url: URL, bridgePort: string): Promise<Response> {
  const routes: Record<string, { method: string; target: string; timeoutMs: number }> = {
    "/api/settings": { method: "GET", target: "/isymcp/settings", timeoutMs: 2_000 },
    "/api/settings/open": { method: "POST", target: "/isymcp/settings/open", timeoutMs: 5_000 },
    "/api/settings/finish": { method: "POST", target: "/isymcp/settings/finish", timeoutMs: 5_000 },
    // Verificar puede esperar a que termine un turno (candado) y lanzar Chrome.
    "/api/settings/verify": { method: "POST", target: "/isymcp/settings/verify", timeoutMs: 240_000 },
  };
  const route = routes[url.pathname];
  if (!route) return apiError(404, "not_found", "ruta desconocida");
  if (req.method !== route.method) return apiError(405, "method_not_allowed", route.method);
  try {
    const r = await fetch(`http://127.0.0.1:${bridgePort}${route.target}`, {
      method: route.method,
      headers: route.method === "POST" ? { "content-type": "application/json" } : undefined,
      body: route.method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(route.timeoutMs),
    });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return apiError(503, "bridge_unavailable", "el bridge local no responde");
  }
}

/** Sesiones del usuario para el selector del chat: SIN token. */
export function publicSessions() {
  let sessions: Array<{ fp: string; label: string; cwd: string; writable: boolean; expiresAt: string | null; expired: boolean }> = [];
  try {
    sessions = listUserSessions().map((x) => ({
      fp: x.fp, label: x.label, cwd: x.cwd, writable: x.writable, expiresAt: x.expiresAt ?? null, expired: isExpired(x),
    }));
  } catch {
    /* registro ilegible: lista vacia, el CLI explica */
  }
  return { sessions, tunnel: pgrep("tunnel-client run") ? "ready" : "stopped" };
}

/**
 * API de harnesses. Aplicar exige {confirm: true} ademas de la guarda
 * Host/Origin/JSON: una pagina ajena no puede instalar nada (CSRF) y el boton
 * solo existe tras ver el plan con los comandos exactos.
 */
export async function handleHarnessApi(req: Request, url: URL): Promise<Response> {
  if (url.pathname === "/api/harness" && req.method === "GET") {
    return Response.json({ harnesses: await harnessDetect() });
  }
  const body = (await req.json().catch(() => null)) as { action?: unknown; ids?: unknown; confirm?: unknown } | null;
  const action = body?.action === "install" || body?.action === "uninstall" ? (body.action as HarnessAction) : null;
  const ids = Array.isArray(body?.ids) ? (body!.ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 32) : [];
  if (!action || ids.length === 0) return apiError(400, "harness_bad_request", "se espera {action: install|uninstall, ids: [...]}");
  if (url.pathname === "/api/harness/plan" && req.method === "POST") {
    return Response.json({ steps: await harnessPlan(action, ids) });
  }
  if (url.pathname === "/api/harness/apply" && req.method === "POST") {
    if (body?.confirm !== true) return apiError(400, "harness_not_confirmed", "falta la confirmacion explicita");
    return Response.json({ results: await harnessApply(action, ids, true) });
  }
  return apiError(404, "not_found", "ruta desconocida");
}
