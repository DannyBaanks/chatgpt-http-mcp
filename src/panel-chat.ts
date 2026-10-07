// panel-chat.ts — pestana "Chat" del panel (Fase 1).
//
// El navegador es una VISTA: solo conoce chat_id y el texto que escribe. El
// backend (bridge) resuelve chat_id -> /c/ y habla con ChatGPT. Ningun token,
// cookie ni storage-state pasa por aqui.
//
// Todo el DOM se construye con textContent; lo unico que entra como HTML es la
// salida de renderMarkdown (que escapa todo antes de transformar).
import { renderMarkdown } from "./markdown";

export const CHAT_STYLE = `
.chat{display:grid;grid-template-columns:250px minmax(0,1fr) 270px;height:calc(100vh - 57px);min-height:0}
.chat>*{min-width:0;min-height:0}
.side,.config{background:#0c0f0d;border-color:var(--line);border-style:solid;border-width:0;overflow:auto}
.side{border-right-width:1px;padding:12px}
.config{border-left-width:1px;padding:16px}
.newchat{width:100%;display:flex;gap:8px;align-items:center;justify-content:center;font:600 13px var(--sans);color:var(--ink);background:#141a17;border:1px solid var(--line);border-radius:10px;padding:9px;cursor:pointer}
.newchat:hover{border-color:var(--ok)}
.chatlist{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}
.chatlist button{width:100%;text-align:left;background:none;border:0;color:var(--ink);font:13px var(--sans);padding:8px 10px;border-radius:8px;cursor:pointer;display:flex;flex-direction:column;gap:2px}
.chatlist button:hover{background:#141a17}
.chatlist button.on{background:#18201c;box-shadow:inset 2px 0 0 var(--ok)}
.chatlist .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chatlist .s{font:11px var(--mono);color:var(--mute)}
.convo{display:flex;flex-direction:column;min-height:0}
.msgs{flex:1;overflow:auto;padding:24px max(16px,calc((100% - 760px)/2)) 12px}
.empty{margin:18vh auto 0;text-align:center;color:var(--mute);max-width:420px}
.empty h2{font:700 20px var(--mono);color:var(--ok);letter-spacing:.08em;margin:0 0 8px}
.msg{margin:0 0 18px}
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
.toggle{display:inline-flex;align-items:center;gap:8px;font:12px var(--mono);color:var(--mute)}
.toggle span{width:30px;height:16px;border-radius:9px;background:#26302b;position:relative}
.toggle span::after{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#5b6b62}
.drawer-btn{display:none}
@media (max-width:980px){
  .chat{grid-template-columns:minmax(0,1fr)}
  .side,.config{position:fixed;top:57px;bottom:0;z-index:5;width:min(300px,86vw);transform:translateX(-105%);transition:transform .18s}
  .side{left:0}.config{right:0;left:auto;transform:translateX(105%)}
  body.show-side .side,body.show-config .config{transform:none;box-shadow:0 0 40px rgba(0,0,0,.6)}
  .drawer-btn{display:inline-flex}
}
`;

export function renderChatView(): string {
  return `<div class="chat">
  <aside class="side" aria-label="Chats">
    <button class="newchat" id="newchat">＋ Nuevo chat</button>
    <ul class="chatlist" id="chatlist"></ul>
  </aside>
  <section class="convo">
    <div class="msgs" id="msgs"></div>
    <div class="composer">
      <form id="composer">
        <textarea id="input" rows="1" placeholder="Escribe un mensaje… (Enter envía, Shift+Enter nueva línea)"></textarea>
        <button class="send" id="send" type="submit" title="Enviar">↑</button>
      </form>
      <div class="hint" id="hint">cada chat es su propia conversación en chatgpt.com</div>
    </div>
  </section>
  <aside class="config" aria-label="Configuración">
    <div class="row"><h4>MODELO</h4><div class="val">Default de tu cuenta</div>
      <div class="note">El transporte web no elige modelo: usa el que tenga chatgpt.com. Sincronizar reasoning/ajustes llega en la próxima fase.</div></div>
    <div class="row"><h4>CODEX ISyMCP</h4><span class="toggle"><span></span> OFF</span>
      <div class="note">Tools apagadas en cada chat nuevo. Encenderlas llega en la Fase 2.</div></div>
    <div class="row"><h4>CONVERSACIÓN</h4><div class="val" id="convlink"><span class="muted">sin /c/ todavía</span></div>
      <div class="note">Se crea con el primer mensaje.</div></div>
    <div class="row"><h4>BRIDGE</h4><div class="val" id="bridgestate">—</div></div>
  </aside>
</div>`;
}

export const CHAT_SCRIPT = `
const md=(${renderMarkdown.toString()});
const $=(id)=>document.getElementById(id);
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
const chat={list:[],current:null,pending:null,timer:null,creating:null};
try{chat.current=localStorage.getItem('isymcp.chat')}catch{}
const KIND={
  provider_blocked:['bad','Bloqueado por OpenAI','ChatGPT rechazó o bloqueó esta solicitud. Nada se ejecutó en tu máquina.'],
  session:['warn','Sesión de ChatGPT inactiva','Las cookies vencieron o faltan: reimporta la sesión (scripts/import-cookies.ts).'],
  browser:['bad','Chrome se cayó','El navegador headless falló y no se pudo recuperar el turno.'],
  capture:['warn','No se pudo leer la respuesta','ChatGPT no devolvió una respuesta legible, o la conversación no se pudo asociar.'],
  bridge:['bad','El bridge no completó el turno','Falló el bridge local mientras hablaba con ChatGPT.'],
  unavailable:['bad','ISyMCP no disponible','El bridge local no responde. Enciéndelo para chatear.'],
};
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});let j=null;try{j=await r.json()}catch{}return {status:r.status,ok:r.ok,json:j};}
function relTime(iso){const s=(Date.now()-Date.parse(iso))/1000;if(s<60)return 'ahora';if(s<3600)return Math.round(s/60)+' min';if(s<86400)return Math.round(s/3600)+' h';return Math.round(s/86400)+' d';}
function renderList(){const ul=$('chatlist');ul.replaceChildren();
  if(!chat.list.length){ul.appendChild(el('li','muted small','(sin chats)'));return;}
  for(const c of chat.list){const li=el('li');const b=el('button',c.id===chat.current?'on':'');b.appendChild(el('span','t',c.title));
    b.appendChild(el('span','s',(c.conversation_url?'':'nuevo · ')+relTime(c.updated_at)+(chat.pending&&chat.pending.chat===c.id?' · …':'')));
    b.onclick=()=>{openChat(c.id);document.body.classList.remove('show-side');};li.appendChild(b);ul.appendChild(li);}}
async function loadList(){const r=await api('/api/chats');if(r.ok){const fresh=r.json.chats;
  // No perder un chat recien creado si esta respuesta salio antes de crearlo (carrera al cargar).
  for(const c of chat.list)if(!fresh.some(f=>f.id===c.id)&&c.id===chat.current)fresh.unshift(c);chat.list=fresh;renderList();}}
function scrollEnd(){const m=$('msgs');m.scrollTop=m.scrollHeight;}
function addCopy(root){root.querySelectorAll('pre').forEach(pre=>{const b=el('button','copy','copiar');b.type='button';b.onclick=()=>{navigator.clipboard?.writeText(pre.querySelector('code').textContent);b.textContent='copiado';setTimeout(()=>b.textContent='copiar',1200);};pre.appendChild(b);});}
function metaLine(m,url){const d=el('div','meta');d.appendChild(el('span','','modelo default'));if(m&&m.ms!=null)d.appendChild(el('span','',(m.ms/1000).toFixed(1)+' s'));
  const u=(m&&m.url)||url;if(u){const a=el('a','', 'Abrir en ChatGPT ↗');a.href=u;a.target='_blank';a.rel='noreferrer';d.appendChild(a);}return d;}
function renderMessage(m,url){const box=el('div','msg '+(m.role==='user'?'user':'assistant'));
  if(m.role==='user'){box.appendChild(el('div','bubble',m.text));return box;}
  if(m.role==='assistant'){const body=el('div','body');body.innerHTML=md(m.text);addCopy(body);box.appendChild(body);box.appendChild(metaLine(m.meta,url));return box;}
  const kind=(m.meta&&m.meta.kind)||'bridge';const [tone,title,expl]=KIND[kind]||KIND.bridge;
  const card=el('div','errcard tone-'+tone);const h=el('div','h');h.appendChild(el('span','','⚠'));h.appendChild(el('span','',title));card.appendChild(h);
  card.appendChild(el('div','p',kind==='provider_blocked'?(m.text+' — '+expl):expl));
  const det=(m.meta&&m.meta.detail)||(kind!=='provider_blocked'?m.text:'');
  if(det){const d=el('details');d.appendChild(el('summary','','diagnóstico'));d.appendChild(el('pre','',det));card.appendChild(d);}
  if(kind==='unavailable'){const b=el('button','btn btn-go','Encender server');b.dataset.action='server-start';card.appendChild(b);}
  box.appendChild(card);if(m.meta&&m.meta.ms!=null)box.appendChild(metaLine({ms:m.meta.ms},null));return box;}
function renderEmpty(){const m=$('msgs');m.replaceChildren();const e=el('div','empty');e.appendChild(el('h2','','ISyMCP'));e.appendChild(el('p','','Escribe para empezar. Cada chat abre su propia conversación en chatgpt.com.'));m.appendChild(e);}
function renderConvLink(c){const box=$('convlink');box.replaceChildren();
  if(c&&c.conversation_url){const a=el('a','',c.conversation_url.replace('https://',''));a.href=c.conversation_url;a.target='_blank';a.rel='noreferrer';a.style.cssText='color:var(--ok);font:12px var(--mono);word-break:break-all';box.appendChild(a);}
  else box.appendChild(el('span','muted','sin /c/ todavía'));}
let currentData=null;
async function openChat(id){chat.touched=true;chat.current=id;try{localStorage.setItem('isymcp.chat',id)}catch{}renderList();
  const r=await api('/api/chats/'+encodeURIComponent(id));
  if(!r.ok){chat.current=null;currentData=null;renderEmpty();renderConvLink(null);return;}
  currentData=r.json;const m=$('msgs');m.replaceChildren();
  if(!currentData.messages.length)renderEmpty();
  for(const msg of currentData.messages)m.appendChild(renderMessage(msg,currentData.conversation_url));
  if(chat.pending&&chat.pending.chat===id)m.appendChild(chat.pending.node);
  renderConvLink(currentData);scrollEnd();}
const PHASE={queued:'En cola',navigating:'Cambiando de conversación',thinking:'Pensando',idle:'Pensando'};
function setBusy(b){$('send').disabled=b;$('hint').textContent=b?'esperando a ChatGPT… puedes ver otros chats mientras':'cada chat es su propia conversación en chatgpt.com';}
async function send(text){
  if(chat.pending)return;
  // Si "Nuevo chat" sigue creandose, esperarlo en vez de crear otro.
  if(chat.creating)await chat.creating;
  if(!chat.current){const r=await api('/api/chats',{method:'POST',body:'{}'});if(!r.ok)return;chat.list.unshift(r.json);await openChat(r.json.id);}
  const id=chat.current;const m=$('msgs');if(m.querySelector('.empty'))m.replaceChildren();
  m.appendChild(renderMessage({role:'user',text}));
  const node=el('div','msg assistant');const th=el('div','thinking');th.appendChild(el('i'));const label=el('span','','Enviando…');th.appendChild(label);node.appendChild(th);m.appendChild(node);scrollEnd();
  const t0=Date.now();chat.pending={chat:id,node};setBusy(true);renderList();
  let phase='queued';let shown='';let liveBody=null;
  const tick=()=>{const secs=Math.round((Date.now()-t0)/1000);label.textContent=(shown?'Escribiendo':PHASE[phase])+'… '+secs+' s';};
  chat.timer=setInterval(async()=>{tick();
    try{const s=await api('/api/chat/status');if(s.ok&&s.json){const mine=s.json.chat_id===id;phase=(mine||s.json.phase==='queued')?s.json.phase:'queued';
      // Texto en vivo: cada sondeo trae la respuesta COMPLETA hasta ahora (se reemplaza, no se concatena).
      if(mine&&s.json.partial&&s.json.partial!==shown){shown=s.json.partial;
        if(!liveBody){liveBody=el('div','body live-body');node.insertBefore(liveBody,th);}
        const nearEnd=$('msgs').scrollHeight-$('msgs').scrollTop-$('msgs').clientHeight<80;
        liveBody.innerHTML=md(shown);if(nearEnd&&chat.current===id)scrollEnd();}
      tick();}}catch{}},600);
  let r;try{r=await api('/api/chats/'+encodeURIComponent(id)+'/messages',{method:'POST',body:JSON.stringify({message:text})});}catch(e){r={status:0,ok:false,json:null};}
  clearInterval(chat.timer);chat.pending=null;setBusy(false);
  if(r.status===503||r.status===0){node.replaceWith(renderMessage({role:'error',text:(r.json&&r.json.error&&r.json.error.message)||'sin respuesta del bridge',meta:{kind:'unavailable'}}));}
  else if(!r.ok){node.replaceWith(renderMessage({role:'error',text:(r.json&&r.json.error&&r.json.error.message)||('HTTP '+r.status),meta:{kind:'bridge'}}));}
  await loadList();if(chat.current===id&&r.ok)await openChat(id);else if(chat.current===id)scrollEnd();}
$('composer').addEventListener('submit',(e)=>{e.preventDefault();const t=$('input').value.trim();if(!t||chat.pending)return;$('input').value='';$('input').style.height='';send(t);});
$('input').addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('composer').requestSubmit();}});
$('input').addEventListener('input',()=>{const t=$('input');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,200)+'px';});
$('newchat').onclick=()=>{if(chat.creating)return chat.creating;chat.creating=(async()=>{try{const r=await api('/api/chats',{method:'POST',body:'{}'});if(r.ok){chat.list.unshift(r.json);await openChat(r.json.id);document.body.classList.remove('show-side');$('input').focus();}}finally{chat.creating=null;}})();return chat.creating;};
async function bridgeState(){const s=await api('/api/chat/status').catch(()=>null);const b=$('bridgestate');b.replaceChildren();
  const ok=s&&s.ok;const dot=el('span','',ok?'● en línea':'● apagado');dot.style.color=ok?'var(--ok)':'var(--bad)';b.appendChild(dot);
  if(!ok){const btn=el('button','btn btn-go','Encender');btn.dataset.action='server-start';btn.style.marginLeft='8px';b.appendChild(btn);}}
(async()=>{await loadList();if(!chat.touched){if(chat.current&&chat.list.some(c=>c.id===chat.current))await openChat(chat.current);else{chat.current=null;renderEmpty();}}bridgeState();setInterval(bridgeState,5000);})();
`;
