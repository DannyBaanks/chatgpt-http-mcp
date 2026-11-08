// src/control-center/ui.ts — Frontend interactivo para el ISyMCP Control Center.

export const CONTROL_CENTER_STYLE = `
.cc-root {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 57px);
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
}

.cc-subnav {
  display: flex;
  gap: 6px;
  padding: 10px 18px;
  background: #0f1411;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
  white-space: nowrap;
}

.cc-subnav button {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--mute);
  font: 600 12px var(--mono);
  padding: 6px 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.cc-subnav button:hover {
  color: var(--ink);
  background: rgba(255, 255, 255, 0.04);
}

.cc-subnav button.active {
  color: var(--ok);
  background: #17221b;
  border-color: rgba(124, 255, 155, 0.3);
}

.cc-content {
  flex: 1;
  padding: 20px 24px;
  max-width: 1400px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

.cc-view {
  display: none;
}

.cc-view.active {
  display: block;
}

.cc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.cc-card {
  background: #121815;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 16px 18px;
}

.cc-card h3 {
  margin: 0 0 10px 0;
  font: 700 14px var(--mono);
  letter-spacing: 0.04em;
  color: #e5f5eb;
  display: flex;
  align-items: center;
  gap: 8px;
}

.cc-card p {
  margin: 0 0 12px 0;
  color: var(--mute);
  font-size: 13px;
  line-height: 1.4;
}

.cc-stat {
  font: 700 24px var(--mono);
  color: var(--ok);
  margin: 8px 0;
}

.cc-table {
  width: 100%;
  border-collapse: collapse;
  font: 12px var(--mono);
  margin-top: 10px;
}

.cc-table th {
  text-align: left;
  padding: 8px 10px;
  background: #161e19;
  color: var(--mute);
  border-bottom: 1px solid var(--line);
}

.cc-table td {
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  vertical-align: middle;
}

.cc-badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 4px;
  font: 700 10px var(--mono);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.cc-badge.succeeded, .cc-badge.up, .cc-badge.ready {
  background: rgba(124, 255, 155, 0.15);
  color: var(--ok);
  border: 1px solid rgba(124, 255, 155, 0.3);
}

.cc-badge.running, .cc-badge.pending, .cc-badge.warn {
  background: rgba(255, 209, 102, 0.15);
  color: var(--warn);
  border: 1px solid rgba(255, 209, 102, 0.3);
}

.cc-badge.awaiting_approval {
  background: rgba(186, 104, 200, 0.2);
  color: #ba68c8;
  border: 1px solid rgba(186, 104, 200, 0.4);
}

.cc-badge.failed, .cc-badge.down, .cc-badge.cancelled {
  background: rgba(255, 107, 107, 0.15);
  color: var(--bad);
  border: 1px solid rgba(255, 107, 107, 0.3);
}

.cc-form-group {
  margin-bottom: 14px;
}

.cc-form-group label {
  display: block;
  font: 600 12px var(--mono);
  color: #b0c9b9;
  margin-bottom: 6px;
}

.cc-input, .cc-select, .cc-textarea {
  width: 100%;
  box-sizing: border-box;
  background: #0d120f;
  border: 1px solid var(--line);
  color: var(--ink);
  padding: 8px 12px;
  border-radius: 6px;
  font: 13px var(--mono);
  transition: border-color 0.15s ease;
}

.cc-input:focus, .cc-select:focus, .cc-textarea:focus {
  outline: none;
  border-color: var(--ok);
}

.cc-textarea {
  resize: vertical;
  min-height: 80px;
}

.cc-split {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 20px;
}

@media (max-width: 800px) {
  .cc-split {
    grid-template-columns: 1fr;
  }
}

.cc-item-list {
  background: #101612;
  border: 1px solid var(--line);
  border-radius: 8px;
  max-height: 600px;
  overflow-y: auto;
}

.cc-item-btn {
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  color: var(--ink);
  padding: 10px 12px;
  font: 12px var(--mono);
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cc-item-btn:hover {
  background: rgba(255, 255, 255, 0.03);
}

.cc-item-btn.selected {
  background: #17221b;
  color: var(--ok);
  font-weight: 700;
}

.cc-output {
  background: #070908;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  font: 12px var(--mono);
  color: #a3c4b0;
  max-height: 400px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.cc-warn-box {
  background: rgba(255, 209, 102, 0.1);
  border: 1px solid rgba(255, 209, 102, 0.3);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
  font: 12px var(--sans);
  color: #ffd166;
}

.cc-check-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font: 600 12px var(--mono);
  color: #ffd166;
  cursor: pointer;
  margin-top: 8px;
}

.cc-check-label input {
  accent-color: #ffd166;
  width: 16px;
  height: 16px;
}

.cc-cmd-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

.cc-category-title {
  font: 700 13px var(--mono);
  color: var(--ok);
  margin: 18px 0 10px 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid rgba(124, 255, 155, 0.2);
  padding-bottom: 5px;
}

.cc-cmd-btn {
  background: #141c17;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 11px 14px;
  color: var(--ink);
  cursor: pointer;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: all 0.15s ease;
  font-family: var(--sans);
  text-decoration: none;
}

.cc-cmd-btn:hover {
  background: #1a261f;
  border-color: var(--ok);
  transform: translateY(-1px);
}

.cc-cmd-btn:active {
  transform: translateY(0);
}

.cc-cmd-btn .cmd-title {
  font: 600 13px var(--sans);
  color: #eaf8ef;
  display: flex;
  align-items: center;
  gap: 6px;
}

.cc-cmd-btn .cmd-code {
  font: 500 11px var(--mono);
  color: var(--mute);
}

.cc-cmd-btn.danger {
  border-color: rgba(255, 107, 107, 0.35);
  background: #1a1414;
}

.cc-cmd-btn.danger:hover {
  border-color: var(--bad);
  background: #261717;
}

.cc-cmd-btn.danger .cmd-title {
  color: #ff9b9b;
}

.cc-cmd-btn.warn {
  border-color: rgba(255, 209, 102, 0.35);
  background: #1a1813;
}

.cc-cmd-btn.warn:hover {
  border-color: var(--warn);
  background: #242015;
}

.cc-cmd-btn.warn .cmd-title {
  color: #ffe082;
}

.cc-chip-btn {
  background: #18221c;
  border: 1px solid rgba(124, 255, 155, 0.25);
  border-radius: 4px;
  color: #a7dfb8;
  font: 500 11px var(--mono);
  padding: 4px 10px;
  cursor: pointer;
  transition: all 0.1s ease;
}

.cc-chip-btn:hover {
  background: #233329;
  color: var(--ok);
  border-color: var(--ok);
}

.cc-terminal-output {
  background: #050806;
  border: 1px solid #1a2920;
  border-radius: 8px;
  padding: 14px 16px;
  font: 12px var(--mono);
  color: #98f6ba;
  min-height: 200px;
  max-height: 500px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.6);
}
`;

export function renderControlCenterView(): string {
  return `
<div class="cc-root">
  <nav class="cc-subnav">
    <button data-target="cc-dashboard" class="active">📊 Dashboard</button>
    <button data-target="cc-cli-deck">🎮 Comandos CLI</button>
    <button data-target="cc-catalog">📖 Catálogo MCP</button>
    <button data-target="cc-monitor">🛰️ Monitor & Tareas</button>
    <button data-target="cc-tui">🖥️ AGY TUI Spawn</button>
    <button data-target="cc-github">🐙 GitHub Suite</button>
    <button data-target="cc-media">🎬 Multimedia</button>
    <button data-target="cc-comfy">🎨 ComfyUI</button>
    <button data-target="cc-fuzz">⚡ Fuzz & Protocolo</button>
  </nav>

  <main class="cc-content">
    <!-- 1. DASHBOARD & HEALTH -->
    <section id="cc-dashboard" class="cc-view active">
      <div class="cc-grid" id="cc-health-tiles">
        <div class="cc-card"><h3>Bridge Server</h3><div class="cc-stat" id="cc-dash-bridge">…</div><p id="cc-dash-bridge-detail">Cargando...</p></div>
        <div class="cc-card"><h3>Monitor Bus</h3><div class="cc-stat" id="cc-dash-monitor">…</div><p id="cc-dash-monitor-detail">Cargando...</p></div>
        <div class="cc-card"><h3>Túnel Reverso</h3><div class="cc-stat" id="cc-dash-tunnel">…</div><p id="cc-dash-tunnel-detail">Cargando...</p></div>
        <div class="cc-card"><h3>MCP Broker</h3><div class="cc-stat" id="cc-dash-mcp">…</div><p id="cc-dash-mcp-detail">Cargando...</p></div>
      </div>

      <!-- Barra de Ejecución Rápida 1-Click -->
      <div class="cc-card" style="margin-bottom:20px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
          <h3 style="margin:0;">⚡ Ejecución Rápida de Comandos CLI (1-Click)</h3>
          <button class="btn btn-sm btn-go" onclick="ccNavToTab('cc-cli-deck')">🎮 Ver Consola Terminal Completa ›</button>
        </div>
        <p>Lanza comandos de diagnóstico y operación directamente en el host sin abrir una terminal externa:</p>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn btn-go" onclick="ccExecuteCliCommand('doctor')">🩺 isymcp doctor</button>
          <button class="btn" onclick="ccExecuteCliCommand('status')">📊 isymcp status</button>
          <button class="btn" onclick="ccExecuteCliCommand('tree')">🌳 isymcp tree</button>
          <button class="btn" onclick="ccExecuteCliCommand('version')">🏷️ isymcp version</button>
          <button class="btn" onclick="ccExecuteCliCommand('up')">🚀 isymcp up</button>
          <button class="btn" onclick="ccExecuteCliCommand('tunnel', ['status'])">🌐 isymcp tunnel status</button>
          <button class="btn" onclick="ccExecuteCliCommand('monitor', ['tasks'])">📋 isymcp monitor tasks</button>
          <button class="btn" onclick="ccExecuteCliCommand('tui', ['list'])">🖥️ isymcp tui list</button>
          <button class="btn" onclick="ccExecuteCliCommand('github', ['whoami'])">🐙 isymcp github whoami</button>
          <button class="btn" onclick="ccExecuteCliCommand('comfy', ['status'])">🎨 isymcp comfy status</button>
        </div>
      </div>

      <div class="cc-grid">
        <div class="cc-card">
          <h3>Métricas de Cola (SQLite WAL)</h3>
          <p>Leases activos: <b id="cc-stat-leases" style="color:var(--ok)">—</b></p>
          <p>Tareas totales: <b id="cc-stat-tasks" style="color:var(--ink)">—</b></p>
          <p>Tareas pendientes/sin ACK: <b id="cc-stat-unacked" style="color:var(--warn)">—</b></p>
          <div style="margin-top:12px; display:flex; gap:8px;">
            <button class="btn btn-go" onclick="ccRefreshOverview()">↻ Actualizar Métricas</button>
          </div>
        </div>

        <div class="cc-card">
          <h3>Integración ChatGPT Oficial</h3>
          <p>Estado de conector MCP para chatgpt.com:</p>
          <p>Identidad: <code>Codex ISyMCP</code> (@CODEX ISYMCP)</p>
          <p>Guía de registro: <a href="/docs/CHATGPT_APP_INTEGRATION.md" target="_blank" style="color:var(--ok)">Documentación App Privada ↗</a></p>
          <p class="small muted">Nota: ChatGPT no permite inyección directa al sidebar sin alta oficial en cuenta.</p>
        </div>
      </div>
    </section>

    <!-- 2. COMANDOS CLI INTERACTIVOS (COMMAND DECK) -->
    <section id="cc-cli-deck" class="cc-view">
      <!-- Runner de Entrada Libre -->
      <div class="cc-card" style="margin-bottom:20px;">
        <h3>⚡ Terminal Runner de ISyMCP CLI</h3>
        <p>Ejecuta cualquier comando o subcomando de <code>isymcp</code> con un clic o escribiendo argumentos personalizados:</p>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <span style="font:700 14px var(--mono); color:var(--ok)">$ isymcp</span>
          <input type="text" id="cc-cli-custom-input" class="cc-input" placeholder="ej. doctor --json, status, tree, tunnel status..." style="flex:1; min-width:260px;">
          <button class="btn btn-go" id="cc-cli-run-btn" onclick="ccRunCustomCli()">▶ Ejecutar</button>
          <button class="btn" onclick="ccClearCliConsole()">🧹 Limpiar</button>
        </div>
        <div style="display:flex; gap:6px; margin-top:12px; flex-wrap:wrap; align-items:center;">
          <span style="font:600 11px var(--mono); color:var(--mute)">Atajos rápidos:</span>
          <button class="cc-chip-btn" onclick="ccSetCliInput('doctor')">doctor</button>
          <button class="cc-chip-btn" onclick="ccSetCliInput('doctor --json')">doctor --json</button>
          <button class="cc-chip-btn" onclick="ccSetCliInput('status')">status</button>
          <button class="cc-chip-btn" onclick="ccSetCliInput('tree')">tree</button>
          <button class="cc-chip-btn" onclick="ccSetCliInput('version')">version</button>
          <button class="cc-chip-btn" onclick="ccSetCliInput('up')">up</button>
          <button class="cc-chip-btn" onclick="ccSetCliInput('tunnel status')">tunnel status</button>
          <button class="cc-chip-btn" onclick="ccSetCliInput('monitor tasks')">monitor tasks</button>
          <button class="cc-chip-btn" onclick="ccSetCliInput('tui list')">tui list</button>
          <button class="cc-chip-btn" onclick="ccSetCliInput('github status')">github status</button>
        </div>
      </div>

      <!-- Consola de Salida del CLI -->
      <div class="cc-card" style="margin-bottom:24px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
          <h3 style="margin:0;">📟 Consola de Salida del Terminal</h3>
          <div style="display:flex; gap:8px; align-items:center;">
            <span id="cc-cli-status-badge" class="cc-badge ready">LISTA</span>
            <span id="cc-cli-duration" style="font:600 11px var(--mono); color:var(--mute);">0ms</span>
            <button class="btn btn-sm" onclick="ccCopyCliConsole()">📋 Copiar</button>
            <button class="btn btn-sm" onclick="ccClearCliConsole()">🧹 Limpiar</button>
          </div>
        </div>

        <div id="cc-cli-command-echo" style="font:700 12px var(--mono); color:var(--ok); margin-bottom:8px; display:none;">
          $ <span id="cc-cli-command-echo-text">isymcp</span>
        </div>

        <!-- Alerta de confirmación para comandos destructivos -->
        <div id="cc-cli-confirm-box" class="cc-warn-box" style="display:none;">
          <div id="cc-cli-confirm-msg">⚠️ Este comando es destructivo.</div>
          <label class="cc-check-label" style="margin-top:8px;">
            <input type="checkbox" id="cc-cli-confirm-check">
            <span>Confirmar ejecución explícita de este comando en el host</span>
          </label>
          <div style="margin-top:10px; display:flex; gap:8px;">
            <button class="btn btn-bad" id="cc-cli-confirm-run-btn" onclick="ccRunPendingDestructive()">⚠️ Ejecutar con confirmación</button>
            <button class="btn" onclick="ccCancelPendingDestructive()">Cancelar</button>
          </div>
        </div>

        <pre id="cc-cli-console" class="cc-terminal-output">$ isymcp listo para recibir comandos.</pre>
      </div>

      <!-- BOTONES DE TODOS LOS COMANDOS DEL CLI POR CATEGORÍA -->
      <div class="cc-category-title">🩺 1. DIAGNÓSTICO, SALUD & ESTADO</div>
      <div class="cc-cmd-grid">
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('doctor')">
          <span class="cmd-title">🩺 Doctor Completo</span>
          <span class="cmd-code">isymcp doctor</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('doctor', ['--json'])">
          <span class="cmd-title">📋 Doctor (JSON)</span>
          <span class="cmd-code">isymcp doctor --json</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('status')">
          <span class="cmd-title">📊 Estado General</span>
          <span class="cmd-code">isymcp status</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('tree')">
          <span class="cmd-title">🌳 Árbol de Comandos</span>
          <span class="cmd-code">isymcp tree</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('version')">
          <span class="cmd-title">🏷️ Versión Instalada</span>
          <span class="cmd-code">isymcp version</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('health')">
          <span class="cmd-title">❤️ Chequeo Health</span>
          <span class="cmd-code">isymcp health</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('metrics')">
          <span class="cmd-title">📈 Métricas Bridge</span>
          <span class="cmd-code">isymcp metrics</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('canary', ['run'])">
          <span class="cmd-title">🐤 Canario de Validación</span>
          <span class="cmd-code">isymcp canary run</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('smoke')">
          <span class="cmd-title">💨 Smoke Test E2E</span>
          <span class="cmd-code">isymcp smoke</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('protocol')">
          <span class="cmd-title">📜 Protocolo de Agentes</span>
          <span class="cmd-code">isymcp protocol</span>
        </button>
      </div>

      <div class="cc-category-title">🚀 2. SERVIDORES & TÚNEL REVERSO</div>
      <div class="cc-cmd-grid">
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('up')">
          <span class="cmd-title">🚀 Levantar Todo (up)</span>
          <span class="cmd-code">isymcp up</span>
        </button>
        <button class="cc-cmd-btn danger" onclick="ccExecuteCliCommand('down')">
          <span class="cmd-title">🛑 Detener Todo (down)</span>
          <span class="cmd-code">isymcp down [confirmar]</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('server', ['start'])">
          <span class="cmd-title">🔌 Iniciar Bridge Server</span>
          <span class="cmd-code">isymcp server start</span>
        </button>
        <button class="cc-cmd-btn danger" onclick="ccExecuteCliCommand('server', ['stop'])">
          <span class="cmd-title">⏹️ Detener Bridge Server</span>
          <span class="cmd-code">isymcp server stop [confirmar]</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('tunnel', ['status'])">
          <span class="cmd-title">🌐 Estado del Túnel</span>
          <span class="cmd-code">isymcp tunnel status</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('tunnel', ['connect'])">
          <span class="cmd-title">🔗 Conectar Túnel</span>
          <span class="cmd-code">isymcp tunnel connect</span>
        </button>
        <button class="cc-cmd-btn danger" onclick="ccExecuteCliCommand('tunnel', ['stop'])">
          <span class="cmd-title">🔌 Desconectar Túnel</span>
          <span class="cmd-code">isymcp tunnel stop [confirmar]</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('panel', ['status'])">
          <span class="cmd-title">🎛️ Estado del Panel</span>
          <span class="cmd-code">isymcp panel status</span>
        </button>
      </div>

      <div class="cc-category-title">🛰️ 3. MONITOR BUS & TAREAS (SQLITE WAL)</div>
      <div class="cc-cmd-grid">
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('monitor', ['status'])">
          <span class="cmd-title">🛰️ Estado del Monitor</span>
          <span class="cmd-code">isymcp monitor status</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('monitor', ['tasks'])">
          <span class="cmd-title">📋 Tareas en Buzón</span>
          <span class="cmd-code">isymcp monitor tasks</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('monitor', ['alert', '--title', 'Alerta Control Center', '--summary', 'Notificación enviada desde UI'])">
          <span class="cmd-title">🔔 Enviar Alerta de Prueba</span>
          <span class="cmd-code">isymcp monitor alert</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('monitor', ['wait-next', '10'])">
          <span class="cmd-title">⏳ Esperar Tarea (10s)</span>
          <span class="cmd-code">isymcp monitor wait-next 10</span>
        </button>
      </div>

      <div class="cc-category-title">🖥️ 4. AGENTES & INTEGRACIÓN TUI</div>
      <div class="cc-cmd-grid">
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('tui', ['list'])">
          <span class="cmd-title">🖥️ Listar TUIs del Sistema</span>
          <span class="cmd-code">isymcp tui list</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccPromptAndExecute('tui', 'Hola agy desde Control Center', 'spawn')">
          <span class="cmd-title">🚀 Lanzar AGY TUI Interactiva</span>
          <span class="cmd-code">isymcp tui spawn "..."</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('tui', ['install', 'all'])">
          <span class="cmd-title">🛠️ Plan Instalar TUIs</span>
          <span class="cmd-code">isymcp tui install all (dry-run)</span>
        </button>
        <button class="cc-cmd-btn warn" onclick="ccExecuteCliCommand('tui', ['install', 'all', '--apply'])">
          <span class="cmd-title">💾 Aplicar MCP en TUIs</span>
          <span class="cmd-code">isymcp tui install all --apply</span>
        </button>
      </div>

      <div class="cc-category-title">🐙 5. EXTENSIONES, MULTIMEDIA & MODELOS</div>
      <div class="cc-cmd-grid">
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('github', ['status'])">
          <span class="cmd-title">🐙 Estado de GitHub</span>
          <span class="cmd-code">isymcp github status</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('github', ['whoami'])">
          <span class="cmd-title">👤 GitHub Whoami</span>
          <span class="cmd-code">isymcp github whoami</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('github', ['prs'])">
          <span class="cmd-title">📑 Listar PRs GitHub</span>
          <span class="cmd-code">isymcp github prs</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('media', ['list'])">
          <span class="cmd-title">🎬 Listar Medios Locales</span>
          <span class="cmd-code">isymcp media list</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('comfy', ['status'])">
          <span class="cmd-title">🎨 Estado ComfyUI</span>
          <span class="cmd-code">isymcp comfy status</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('comfy', ['workflows'])">
          <span class="cmd-title">🖼️ Workflows ComfyUI</span>
          <span class="cmd-code">isymcp comfy workflows</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('models')">
          <span class="cmd-title">🧠 Catálogo Modelos Codex</span>
          <span class="cmd-code">isymcp models (dry-run)</span>
        </button>
        <button class="cc-cmd-btn" onclick="ccExecuteCliCommand('fuzz', ['15'])">
          <span class="cmd-title">⚡ Suite Fuzzing (15 it)</span>
          <span class="cmd-code">isymcp fuzz 15</span>
        </button>
      </div>

      <div class="cc-category-title">💬 6. INTERACTIVO & SHELL RUNNER</div>
      <div class="cc-cmd-grid">
        <button class="cc-cmd-btn" onclick="ccPromptAndExecute('ask', '¿Qué herramientas MCP tienes disponibles?')">
          <span class="cmd-title">💬 Preguntar a ChatGPT</span>
          <span class="cmd-code">isymcp ask "..."</span>
        </button>
        <button class="cc-cmd-btn danger" onclick="ccPromptExecShell()">
          <span class="cmd-title">💻 Ejecutar Shell Arbitrario</span>
          <span class="cmd-code">isymcp exec "..." [confirmar]</span>
        </button>
      </div>
    </section>

    <!-- 2. CATÁLOGO CLI & HERRAMIENTAS -->
    <section id="cc-catalog" class="cc-view">
      <div class="cc-split">
        <div>
          <div class="cc-item-list" id="cc-catalog-list">
            <div style="padding:12px; color:var(--mute)">Cargando glosario...</div>
          </div>
        </div>

        <div>
          <div class="cc-card" id="cc-catalog-detail">
            <h3 id="cc-action-title">Selecciona una acción del catálogo</h3>
            <p id="cc-action-desc">Consulta los contratos reales, esquemas y parámetros tipados descubiertos desde el Universal Gateway.</p>

            <form id="cc-action-form" style="display:none;" onsubmit="ccSubmitAction(event)">
              <div id="cc-action-fields"></div>

              <div id="cc-action-danger" class="cc-warn-box" style="display:none;">
                <b>⚠️ ADVERTENCIA DE SEGURIDAD</b>
                <div id="cc-action-danger-text">Esta acción tiene efectos en el host.</div>
                <label class="cc-check-label">
                  <input type="checkbox" id="cc-confirm-checkbox"> Confirmo explícitamente la ejecución
                </label>
              </div>

              <div style="margin-top:16px; display:flex; gap:10px;">
                <button type="submit" class="btn btn-go" id="cc-run-btn">▶ Ejecutar Acción</button>
                <button type="button" class="btn" onclick="ccFillExample()">Cargar Ejemplo</button>
              </div>
            </form>

            <div style="margin-top:20px;">
              <h4 style="font:600 12px var(--mono); color:var(--mute); margin-bottom:6px;">Salida / Recibo:</h4>
              <pre class="cc-output" id="cc-action-output">Esperando ejecución…</pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 3. MONITOR & TAREAS -->
    <section id="cc-monitor" class="cc-view">
      <div class="cc-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h3>Cola de Tareas y Recibos Criptográficos HMAC</h3>
          <button class="btn btn-go" onclick="ccLoadTasks()">↻ Refrescar Tareas</button>
        </div>
        <p>Buzón persistido en SQLite WAL (<code>remote-monitor.sqlite</code>). Los recibos firmados certifican la ejecución de agentes.</p>

        <div style="overflow-x:auto;">
          <table class="cc-table" id="cc-tasks-table">
            <thead>
              <tr>
                <th>Estado</th>
                <th>Task ID</th>
                <th>Operation ID</th>
                <th>Kind</th>
                <th>Acciones</th>
                <th>Recibo HMAC</th>
                <th>Gestión</th>
              </tr>
            </thead>
            <tbody id="cc-tasks-tbody">
              <tr><td colspan="7" style="text-align:center; padding:18px;">Cargando tareas del monitor...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 4. AGY TUI SPAWN -->
    <section id="cc-tui" class="cc-view">
      <div class="cc-card" style="max-width:700px; margin:0 auto;">
        <h3>Lanzador de Consolas Interactivas Antigravity (AGY TUI)</h3>
        <p>Despliega un nuevo proceso interactivo visible de Antigravity conectado al monitor con el protocolo de inicialización.</p>

        <form onsubmit="ccSpawnTui(event)">
          <div class="cc-form-group">
            <label>Instrucción / Prompt:</label>
            <textarea class="cc-textarea" id="cc-tui-prompt" placeholder="Ej: Auditar integridad de la arquitectura y ejecutar tests" required></textarea>
          </div>

          <div class="cc-form-group">
            <label>Modo de Trabajo:</label>
            <select class="cc-select" id="cc-tui-mode" onchange="ccCheckTuiDanger()">
              <option value="auto" selected>auto (Supervisión con herramientas estándar)</option>
              <option value="plan">plan (Solo planificación y lectura)</option>
              <option value="accept-edits">accept-edits (⚠️ Aceptación directa de ediciones de archivos)</option>
            </select>
          </div>

          <div class="cc-form-group">
            <label>Terminal Destino:</label>
            <select class="cc-select" id="cc-tui-terminal">
              <option value="auto" selected>auto (Detección automática: GNOME / tmux)</option>
              <option value="gui">gui (Ventana gráfica independiente)</option>
              <option value="tmux">tmux (Sesión desacoplada)</option>
            </select>
          </div>

          <div class="cc-form-group">
            <label>Título de la Ventana (opcional):</label>
            <input type="text" class="cc-input" id="cc-tui-title" placeholder="AGY Inspector">
          </div>

          <div id="cc-tui-danger-box" class="cc-warn-box" style="display:none;">
            <b>⚠️ MODO EDIT AUTORIZADO</b>
            <div>El modo 'accept-edits' permite a Antigravity escribir directamente sin confirmaciones intermedias.</div>
            <label class="cc-check-label">
              <input type="checkbox" id="cc-tui-confirm"> Confirmo expresamente lanzar en modo accept-edits
            </label>
          </div>

          <div style="margin-top:18px;">
            <button type="submit" class="btn btn-go" id="cc-tui-submit-btn">🚀 Lanzar Consola TUI</button>
          </div>
        </form>

        <div style="margin-top:20px;">
          <h4 style="font:600 12px var(--mono); color:var(--mute); margin-bottom:6px;">Resultado del Lanzamiento:</h4>
          <pre class="cc-output" id="cc-tui-output">Sin ejecuciones recientes.</pre>
        </div>
      </div>
    </section>

    <!-- 5. GITHUB SUITE -->
    <section id="cc-github" class="cc-view">
      <div class="cc-card">
        <h3>GitHub Suite — Operaciones Autenticadas (DannyBaanks)</h3>
        <p>Consulta cuota de API, repositorios, pull requests y estado de CI sin filtrar tokens a la interfaz.</p>

        <div style="display:flex; gap:10px; margin-bottom:16px;">
          <button class="btn btn-go" onclick="ccRunGithub('github.status')">Comprobar Estado & Rate Limit</button>
          <button class="btn" onclick="ccRunGithub('github.whoami')">Ver Perfil Autenticado</button>
          <button class="btn" onclick="ccRunGithub('github.prs', { owner: 'DannyBaanks', repo: 'chatgpt-http-mcp' })">Ver PRs de chatgpt-http-mcp</button>
        </div>

        <pre class="cc-output" id="cc-github-output">Haz clic en una opción para consultar GitHub.</pre>
      </div>
    </section>

    <!-- 6. MULTIMEDIA -->
    <section id="cc-media" class="cc-view">
      <div class="cc-card">
        <h3>Herramientas Multimedia Locales</h3>
        <p>Análisis de video, espectrogramas de audio y hojas de contacto sin subir binarios a OpenAI.</p>

        <div style="display:flex; gap:10px; margin-bottom:16px;">
          <button class="btn btn-go" onclick="ccRunMedia('media.list')">Listar Activos Locales</button>
        </div>

        <div class="cc-form-group" style="max-width:500px;">
          <label>Consultar URL de YouTube / Shorts:</label>
          <div style="display:flex; gap:8px;">
            <input type="text" class="cc-input" id="cc-media-url" placeholder="https://www.youtube.com/watch?v=...">
            <button class="btn btn-go" onclick="ccLookupMedia()">Verificar</button>
          </div>
        </div>

        <pre class="cc-output" id="cc-media-output">Inventario multimedia local listo.</pre>
      </div>
    </section>

    <!-- 7. COMFYUI -->
    <section id="cc-comfy" class="cc-view">
      <div class="cc-card">
        <h3>ComfyUI — Generación Local de Imágenes</h3>
        <p>Supervisa el servicio ComfyUI en loopback y consulta los workflows registrados.</p>

        <div style="display:flex; gap:10px; margin-bottom:16px;">
          <button class="btn btn-go" onclick="ccRunComfy('comfyui.status')">Estado del Servicio ComfyUI</button>
          <button class="btn" onclick="ccRunComfy('comfyui.workflows')">Catálogo de Workflows</button>
        </div>

        <pre class="cc-output" id="cc-comfy-output">ComfyUI listo para diagnóstico.</pre>
      </div>
    </section>

    <!-- 8. FUZZ & PROTOCOLO -->
    <section id="cc-fuzz" class="cc-view">
      <div class="cc-grid">
        <div class="cc-card">
          <h3>Pruebas de Fuzzing Adversarial</h3>
          <p>Ejecuta suites de robustez sintáctica y semántica contra los instaladores de TUIs y Universal Gateway.</p>
          <div style="margin-bottom:12px;">
            <label style="font:600 12px var(--mono); color:var(--mute)">Iteraciones:</label>
            <input type="number" class="cc-input" id="cc-fuzz-iterations" value="25" min="5" max="200" style="width:100px; display:inline-block; margin-left:8px;">
          </div>
          <button class="btn btn-go" id="cc-fuzz-btn" onclick="ccRunFuzz()">⚡ Iniciar Fuzzing</button>
          <pre class="cc-output" id="cc-fuzz-output" style="margin-top:14px;">Listo para ejecutar fuzzing.</pre>
        </div>

        <div class="cc-card">
          <h3>Protocolo de Coordinación de Agentes</h3>
          <p>Documento oficial <code>isymcp://protocol/agents.md</code> con la secuencia de inicialización <code>/task</code>.</p>
          <button class="btn" onclick="ccCopyProtocol()">📋 Copiar Protocolo Markdown</button>
          <pre class="cc-output" id="cc-protocol-text" style="margin-top:14px; max-height:450px;">Cargando protocolo...</pre>
        </div>
      </div>
    </section>
  </main>
</div>
`;
}

export const CONTROL_CENTER_SCRIPT = `
let ccGlossary = null;
let ccSelectedAction = null;

// Sub-navegación dentro de Control Center
document.querySelectorAll('.cc-subnav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cc-subnav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.cc-view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    const target = document.getElementById(btn.dataset.target);
    if (target) target.classList.add('active');

    if (btn.dataset.target === 'cc-catalog' && !ccGlossary) ccLoadGlossary();
    if (btn.dataset.target === 'cc-monitor') ccLoadTasks();
    if (btn.dataset.target === 'cc-fuzz') ccLoadProtocol();
  });
});

async function ccRefreshOverview() {
  try {
    const res = await fetch('/api/control-center/overview');
    if (!res.ok) return;
    const data = await res.json();

    const setBadge = (elId, status, detailId, detailText) => {
      const el = document.getElementById(elId);
      const dt = document.getElementById(detailId);
      if (el) {
        el.textContent = status.toUpperCase();
        el.className = 'cc-stat ' + (status === 'up' || status === 'ready' ? 'tone-ok' : status === 'warn' ? 'tone-warn' : 'tone-bad');
        el.style.color = (status === 'up' || status === 'ready') ? 'var(--ok)' : status === 'warn' ? 'var(--warn)' : 'var(--bad)';
      }
      if (dt && detailText) dt.textContent = detailText;
    };

    const br = data.services.find(s => s.id === 'bridge');
    const mo = data.services.find(s => s.id === 'monitor');
    const tu = data.services.find(s => s.id === 'tunnel');
    const mc = data.services.find(s => s.id === 'mcp-broker');

    if (br) setBadge('cc-dash-bridge', br.status, 'cc-dash-bridge-detail', br.detail);
    if (mo) setBadge('cc-dash-monitor', mo.status, 'cc-dash-monitor-detail', mo.detail);
    if (tu) setBadge('cc-dash-tunnel', tu.status, 'cc-dash-tunnel-detail', tu.detail);
    if (mc) setBadge('cc-dash-mcp', mc.status, 'cc-dash-mcp-detail', mc.detail);

    document.getElementById('cc-stat-leases').textContent = data.monitor.activeLeasesCount;
    document.getElementById('cc-stat-tasks').textContent = data.monitor.totalTasksCount;
    document.getElementById('cc-stat-unacked').textContent = data.monitor.unackedTasksCount;
  } catch (err) {
    console.warn('Error refrescando overview:', err);
  }
}

async function ccLoadGlossary() {
  try {
    const res = await fetch('/api/control-center/glossary');
    if (!res.ok) throw new Error('Error al cargar glosario');
    ccGlossary = await res.json();
    const list = document.getElementById('cc-catalog-list');
    list.innerHTML = '';

    for (const [familyName, family] of Object.entries(ccGlossary.families)) {
      const groupHeader = document.createElement('div');
      groupHeader.style.padding = '8px 12px';
      groupHeader.style.background = '#161e19';
      groupHeader.style.font = '700 11px var(--mono)';
      groupHeader.style.color = 'var(--ok)';
      groupHeader.textContent = familyName.toUpperCase();
      list.appendChild(groupHeader);

      for (const [actionName, actionMeta] of Object.entries(family.actions)) {
        const btn = document.createElement('button');
        btn.className = 'cc-item-btn';
        btn.innerHTML = '<span>' + actionName + '</span><span class="muted small">›</span>';
        btn.onclick = () => ccSelectAction(actionName, actionMeta, familyName);
        list.appendChild(btn);
      }
    }
  } catch (err) {
    document.getElementById('cc-catalog-list').innerHTML = '<div style="padding:12px; color:var(--bad)">' + err.message + '</div>';
  }
}

function ccSelectAction(actionName, actionMeta, familyName) {
  ccSelectedAction = { name: actionName, meta: actionMeta, family: familyName };
  document.querySelectorAll('.cc-item-btn').forEach(b => b.classList.remove('selected'));
  event?.currentTarget?.classList?.add('selected');

  document.getElementById('cc-action-title').textContent = actionName;
  document.getElementById('cc-action-desc').textContent = actionMeta.description;
  const form = document.getElementById('cc-action-form');
  form.style.display = 'block';

  const fields = document.getElementById('cc-action-fields');
  fields.innerHTML = '';

  const params = actionMeta.parameters || {};
  for (const [pName, pType] of Object.entries(params)) {
    const grp = document.createElement('div');
    grp.className = 'cc-form-group';
    grp.innerHTML = '<label>' + pName + ' <span class="muted small">(' + pType + ')</span></label>' +
      '<input type="text" class="cc-input" name="' + pName + '" placeholder="' + pType + '">';
    fields.appendChild(grp);
  }

  // Comprobar peligrosidad
  const isDangerous = actionName === 'shell.exec' || actionName === 'github.dispatch' ||
    (actionName === 'github.api');
  const dangerBox = document.getElementById('cc-action-danger');
  dangerBox.style.display = isDangerous ? 'block' : 'none';
  document.getElementById('cc-confirm-checkbox').checked = false;
}

function ccFillExample() {
  if (!ccSelectedAction || !ccSelectedAction.meta.example) return;
  const ex = ccSelectedAction.meta.example.arguments || {};
  const form = document.getElementById('cc-action-form');
  for (const [k, v] of Object.entries(ex)) {
    const input = form.elements[k];
    if (input) {
      input.value = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
}

async function ccSubmitAction(ev) {
  ev.preventDefault();
  if (!ccSelectedAction) return;

  const form = ev.target;
  const args = {};
  for (const el of form.elements) {
    if (el.name && el.value.trim()) {
      let val = el.value.trim();
      if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
        try { val = JSON.parse(val); } catch {}
      } else if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (!isNaN(Number(val)) && val !== '') val = Number(val);
      args[el.name] = val;
    }
  }

  const confirmed = document.getElementById('cc-confirm-checkbox').checked;
  const operatorGrant = ccSelectedAction.operator_grant || undefined;
  const out = document.getElementById('cc-action-output');
  out.textContent = 'Ejecutando ' + ccSelectedAction.name + '...';

  try {
    const res = await fetch('/api/control-center/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: ccSelectedAction.name,
        arguments: args,
        confirmed,
        operator_grant: confirmed ? operatorGrant : undefined,
      })
    });
    const data = await res.json();
    if (res.status === 403 && data.requires_confirmation) {
      ccSelectedAction.operator_grant = data.operator_grant;
      document.getElementById('cc-action-danger').style.display = 'block';
      document.getElementById('cc-action-danger-text').textContent = data.warning;
      out.textContent = '⚠️ Bloqueado: ' + data.warning;
    } else {
      ccSelectedAction.operator_grant = null;
      out.textContent = JSON.stringify(data, null, 2);
    }
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
  }
}

async function ccLoadTasks() {
  const tbody = document.getElementById('cc-tasks-tbody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:18px;">Consultando tareas...</td></tr>';
  try {
    const res = await fetch('/api/control-center/tasks?limit=25');
    const data = await res.json();
    if (!data.ok || !data.tasks.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:18px; color:var(--mute)">Sin tareas en cola.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    for (const t of data.tasks) {
      const tr = document.createElement('tr');
      const stateClass = t.state.toLowerCase();
      tr.innerHTML = '<td><span class="cc-badge ' + stateClass + '">' + t.state + '</span></td>' +
        '<td><code>' + t.task_id + '</code></td>' +
        '<td><code class="muted">' + t.operation_id + '</code></td>' +
        '<td>' + t.kind + '</td>' +
        '<td class="small muted">' + (t.requested_actions.join(', ') || '—') + '</td>' +
        '<td>' + (t.has_receipt ? '<span style="color:var(--ok)">✓ ' + t.receipt_hmac + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (t.state === 'AWAITING_APPROVAL' ? '<button class="btn btn-go" onclick="ccApproveTask(\\'' + t.task_id + '\\')">Aprobar</button>' : '—') + '</td>';
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--bad)">' + err.message + '</td></tr>';
  }
}

async function ccApproveTask(taskId) {
  try {
    const res = await fetch('/api/control-center/tasks/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task_id: taskId })
    });
    const data = await res.json();
    if (data.ok) {
      alert('✓ Tarea aprobada: ' + taskId);
      ccLoadTasks();
    } else {
      alert('✗ Error al aprobar: ' + data.error);
    }
  } catch (err) {
    alert('✗ Error de conexión: ' + err.message);
  }
}

function ccCheckTuiDanger() {
  const mode = document.getElementById('cc-tui-mode').value;
  document.getElementById('cc-tui-danger-box').style.display = (mode === 'accept-edits') ? 'block' : 'none';
}

async function ccSpawnTui(ev) {
  ev.preventDefault();
  const prompt = document.getElementById('cc-tui-prompt').value.trim();
  const mode = document.getElementById('cc-tui-mode').value;
  const terminal = document.getElementById('cc-tui-terminal').value;
  const title = document.getElementById('cc-tui-title').value.trim();
  const confirmed = document.getElementById('cc-tui-confirm').checked;

  if (mode === 'accept-edits' && !confirmed) {
    alert('Debes confirmar explícitamente el modo accept-edits.');
    return;
  }

  const out = document.getElementById('cc-tui-output');
  out.textContent = 'Lanzando consola Antigravity...';

  try {
    const res = await fetch('/api/control-center/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'tui.spawn',
        arguments: { prompt, mode, terminal, title: title || undefined },
        confirmed: true
      })
    });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
  }
}

async function ccRunGithub(action, args = {}) {
  const out = document.getElementById('cc-github-output');
  out.textContent = 'Consultando GitHub (' + action + ')...';
  try {
    const res = await fetch('/api/control-center/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, arguments: args })
    });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
  }
}

async function ccRunMedia(action, args = {}) {
  const out = document.getElementById('cc-media-output');
  out.textContent = 'Consultando inventario multimedia...';
  try {
    const res = await fetch('/api/control-center/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, arguments: args })
    });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
  }
}

async function ccLookupMedia() {
  const url = document.getElementById('cc-media-url').value.trim();
  if (!url) return;
  ccRunMedia('media.lookup', { url });
}

async function ccRunComfy(action, args = {}) {
  const out = document.getElementById('cc-comfy-output');
  out.textContent = 'Consultando ComfyUI (' + action + ')...';
  try {
    const res = await fetch('/api/control-center/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, arguments: args })
    });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
  }
}

async function ccRunFuzz() {
  const it = Number(document.getElementById('cc-fuzz-iterations').value) || 25;
  const out = document.getElementById('cc-fuzz-output');
  const btn = document.getElementById('cc-fuzz-btn');
  btn.disabled = true;
  out.textContent = 'Ejecutando suite de fuzzing con ' + it + ' iteraciones...';
  try {
    const res = await fetch('/api/control-center/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'fuzz.run', arguments: { iterations: it } })
    });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function ccLoadProtocol() {
  try {
    const res = await fetch('/api/control-center/protocol');
    const text = await res.text();
    document.getElementById('cc-protocol-text').textContent = text;
  } catch (err) {
    document.getElementById('cc-protocol-text').textContent = 'Error cargando protocolo: ' + err.message;
  }
}

function ccCopyProtocol() {
  const text = document.getElementById('cc-protocol-text').textContent;
  navigator.clipboard.writeText(text);
  alert('✓ Protocolo copiado al portapapeles');
}

// ── Comandos CLI interactivos & Terminal Runner ─────────────────────────────
let ccPendingDestructive = null;

function ccNavToTab(tabId) {
  const btn = document.querySelector('.cc-subnav button[data-target="' + tabId + '"]');
  if (btn) btn.click();
}

function ccSetCliInput(cmd) {
  const input = document.getElementById('cc-cli-custom-input');
  if (input) {
    input.value = cmd;
    input.focus();
  }
}

function ccRunCustomCli() {
  const input = document.getElementById('cc-cli-custom-input');
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  ccExecuteCliCommand(val);
}

function ccClearCliConsole() {
  const con = document.getElementById('cc-cli-console');
  if (con) con.textContent = '$ isymcp listo para recibir comandos.';
  const echo = document.getElementById('cc-cli-command-echo');
  if (echo) echo.style.display = 'none';
  const badge = document.getElementById('cc-cli-status-badge');
  if (badge) {
    badge.className = 'cc-badge ready';
    badge.textContent = 'LISTA';
  }
  const dur = document.getElementById('cc-cli-duration');
  if (dur) dur.textContent = '0ms';
  ccCancelPendingDestructive();
}

function ccCopyCliConsole() {
  const con = document.getElementById('cc-cli-console');
  if (!con) return;
  navigator.clipboard.writeText(con.textContent);
  alert('✓ Salida del CLI copiada al portapapeles');
}

function ccCancelPendingDestructive() {
  ccPendingDestructive = null;
  const box = document.getElementById('cc-cli-confirm-box');
  if (box) box.style.display = 'none';
  const chk = document.getElementById('cc-cli-confirm-check');
  if (chk) chk.checked = false;
}

async function ccRunPendingDestructive() {
  const chk = document.getElementById('cc-cli-confirm-check');
  if (!chk || !chk.checked) {
    alert('Debes marcar la casilla para autorizar la ejecución en el host.');
    return;
  }
  if (!ccPendingDestructive) return;
  const { cmd, args, operator_grant } = ccPendingDestructive;
  ccCancelPendingDestructive();
  await ccExecuteCliCommand(cmd, args, { confirmed: true, operator_grant });
}

async function ccExecuteCliCommand(cmd, args = [], options = {}) {
  ccNavToTab('cc-cli-deck');

  const con = document.getElementById('cc-cli-console');
  const badge = document.getElementById('cc-cli-status-badge');
  const dur = document.getElementById('cc-cli-duration');
  const echo = document.getElementById('cc-cli-command-echo');
  const echoText = document.getElementById('cc-cli-command-echo-text');

  if (echo && echoText) {
    echo.style.display = 'block';
    echoText.textContent = 'isymcp ' + cmd + (args && args.length ? ' ' + args.join(' ') : '');
  }

  if (badge) {
    badge.className = 'cc-badge running';
    badge.textContent = 'EJECUTANDO...';
  }
  if (con) con.textContent = '$ Ejecutando isymcp ' + cmd + (args && args.length ? ' ' + args.join(' ') : '') + '...';

  try {
    const res = await fetch('/api/control-center/cli', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: cmd,
        args,
        confirmed: options.confirmed === true,
        operator_grant: options.operator_grant,
      })
    });

    const data = await res.json();

    if (res.status === 403 && data.requires_confirmation) {
      if (badge) {
        badge.className = 'cc-badge warn';
        badge.textContent = 'CONFIRMACIÓN REQUERIDA';
      }
      ccPendingDestructive = { cmd, args, operator_grant: data.operator_grant };
      const box = document.getElementById('cc-cli-confirm-box');
      const msg = document.getElementById('cc-cli-confirm-msg');
      if (box && msg) {
        box.style.display = 'block';
        msg.textContent = '⚠️ Bloqueado: ' + data.warning;
      }
      if (con) con.textContent = '$ isymcp ' + cmd + '\\n✗ Bloqueado por seguridad: ' + data.warning + '\\n\\nConfirma abajo para proceder con la ejecución.';
      return;
    }

    if (badge) {
      badge.className = 'cc-badge ' + (data.ok ? 'succeeded' : 'failed');
      badge.textContent = data.ok ? 'EXIT 0' : ('EXIT ' + (data.exit_code ?? 1));
    }

    if (dur && typeof data.duration_ms === 'number') {
      dur.textContent = data.duration_ms + 'ms';
    }

    let outText = '';
    if (data.stdout) outText += data.stdout;
    if (data.stderr) outText += (outText ? '\\n--- STDERR ---\\n' : '') + data.stderr;
    if (!outText.trim()) outText = '(sin salida producida en stdout/stderr)';

    if (con) con.textContent = outText;

    if (cmd.includes('up') || cmd.includes('down') || cmd.includes('server') || cmd.includes('tunnel')) {
      setTimeout(ccRefreshOverview, 1200);
    }
  } catch (err) {
    if (badge) {
      badge.className = 'cc-badge failed';
      badge.textContent = 'ERROR DE RED';
    }
    if (con) con.textContent = 'Error al comunicar con /api/control-center/cli:\\n' + err.message;
  }
}

function ccPromptAndExecute(cmd, placeholder, paramPrefix = '') {
  const input = prompt('Introduce el parámetro para "isymcp ' + cmd + '":', placeholder);
  if (input === null) return;
  const clean = input.trim();
  if (!clean) return;
  const full = paramPrefix ? (paramPrefix + ' ' + clean) : clean;
  ccExecuteCliCommand(cmd, [full]);
}

function ccPromptExecShell() {
  const cmd = prompt('Introduce el comando shell a ejecutar con isymcp exec:', 'git status');
  if (cmd === null) return;
  const clean = cmd.trim();
  if (!clean) return;
  ccExecuteCliCommand('exec', [clean]);
}

document.getElementById('cc-cli-custom-input')?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    ccRunCustomCli();
  }
});

// Auto-inicio de dashboard en vista inicial
setTimeout(ccRefreshOverview, 100);

`;

export function renderControlCenterEmbeddedHtml(options: { bridgeOrigin?: string } = {}): string {
  const origin = options.bridgeOrigin || "";
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ISyMCP Control Center — OpenAI Apps SDK View</title>
  <style>
:root {
  --bg: #090b0a;
  --panel: #101412;
  --line: #1d2420;
  --ink: #d9e4dc;
  --mute: #6f8076;
  --ok: #7cff9b;
  --warn: #ffcc66;
  --bad: #ff6b6b;
  --idle: #5b6b62;
  --mono: "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: Inter, "Segoe UI", system-ui, sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.45 var(--sans);
  background-image: linear-gradient(rgba(124,255,155,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(124,255,155,.035) 1px, transparent 1px);
  background-size: 28px 28px;
  min-height: 100vh;
}
.btn {
  background: #141b17;
  color: var(--ink);
  border: 1px solid var(--line);
  padding: 7px 14px;
  border-radius: 8px;
  font: 600 12px var(--mono);
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn:hover {
  background: #1a241f;
  border-color: rgba(124,255,155,.3);
}
.btn-go {
  background: rgba(124,255,155,.12);
  color: var(--ok);
  border-color: rgba(124,255,155,.35);
}
.btn-go:hover {
  background: rgba(124,255,155,.22);
}
.btn-stop {
  background: rgba(255,107,107,.12);
  color: var(--bad);
  border-color: rgba(255,107,107,.35);
}
.btn-sm {
  padding: 4px 8px;
  font-size: 11px;
}
.toasts {
  position: fixed;
  bottom: 20px;
  right: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 9999;
}
${CONTROL_CENTER_STYLE}
  </style>
</head>
<body>
  ${renderControlCenterView()}
  <div class="toasts"></div>
  <script>
    window.ISYMCP_BRIDGE_ORIGIN = ${JSON.stringify(origin)};
    ${CONTROL_CENTER_SCRIPT}
    // Puente oficial OpenAI Apps SDK (MCP Apps Protocol via postMessage)
    if (typeof window !== "undefined") {
      window.addEventListener("message", (event) => {
        const data = event.data;
        if (!data) return;

        // 1. JSON-RPC: ui/initialize handshake
        if (data.method === "ui/initialize" && data.id !== undefined) {
          const theme = data.params?.hostContext?.theme;
          if (theme) document.documentElement.setAttribute("data-theme", theme);
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              jsonrpc: "2.0",
              id: data.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: { listChanged: false } },
              },
            }, "*");
            window.parent.postMessage({
              jsonrpc: "2.0",
              method: "ui/notifications/initialized",
              params: {},
            }, "*");
          }
          return;
        }

        // 2. JSON-RPC: ui/notifications/host-context-changed
        if (data.method === "ui/notifications/host-context-changed") {
          const theme = data.params?.hostContext?.theme;
          if (theme) document.documentElement.setAttribute("data-theme", theme);
          return;
        }

        // 3. Fallback compatible para openai:set-theme
        if (data.type === "openai:set-theme" && data.theme) {
          document.documentElement.setAttribute("data-theme", data.theme);
        }
      });

      // Anuncio compatible de disponibilidad hacia el host
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "openai:app-ready", view: "control-center" }, "*");
      }
    }
  </script>
</body>
</html>`;
}

