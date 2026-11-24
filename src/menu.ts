// menu.ts — arbol del menu interactivo de isymcp.
// Las entradas con hidden:true son placeholders de hooks: existen para
// engancharlas despues, y no se pintan ni se pueden elegir.
export interface MenuItem {
  id: string;
  group?: string;
  label: string;
  hint?: string;
  hidden?: boolean;
  children?: MenuItem[];
}

export const MENU: MenuItem[] = [
  { id: "up", group: "PUENTE", label: "▶ Levantar todo", hint: "server + tunel" },
  { id: "down", group: "PUENTE", label: "■ Detener todo", hint: "cierre del server y del tunel" },
  { id: "restart", group: "PUENTE", label: "↻ Reiniciar", hint: "down + up" },
  { id: "status", group: "PUENTE", label: "○ Estado", hint: "server, tunel, panel, canario" },
  { id: "doctor", group: "PUENTE", label: "✚ Diagnóstico local", hint: "binarios, sandbox, disco, último fallo" },
  { id: "panel-open", group: "USAR", label: "◧ Abrir panel", hint: "chat + estado en el navegador" },
  { id: "ask", group: "USAR", label: "✎ Preguntar a ChatGPT…", hint: "turno real desde la terminal" },
  { id: "media-prepare", group: "USAR", label: "Preparar video de YouTube…", hint: "pega URL, elige carpeta y confirma" },
  { id: "conversation-new", group: "USAR", label: "Nueva conversación Codex…", hint: "CLI o App con perfil propio" },
  { id: "command", group: "USAR", label: "Armar comando @…", hint: "texto para pegar en chatgpt.com" },
  { id: "sandbox-exec", group: "USAR", label: "⚡ Sandbox + shell_exec para GPT", hint: "túnel + token + prompt listo" },
  {
    id: "github",
    group: "CONFIGURAR",
    label: "🐙 GitHub Extension…",
    hint: "tokens, API y GitHub Actions",
    children: [
      { id: "github-status", group: "GITHUB", label: "○ Estado y cuenta", hint: "DannyBaanks y scopes" },
      { id: "github-tokens-wizard", group: "GITHUB", label: "🧙 Asistente Wizard: Tokens…", hint: "tiempo en horas, permisos y alias" },
      { id: "github-tokens-list", group: "GITHUB", label: "≣ Listar Tokens guardados", hint: "vigencia, expiración y scopes" },
      { id: "github-repos", group: "GITHUB", label: "📁 Repositorios", hint: "listar tus repos" },
      { id: "hook.github", hidden: true, label: "hook.github" },
    ],
  },
  {
    id: "settings",
    group: "CONFIGURAR",
    label: "Ajustes de ChatGPT…",
    hint: "modelo y reasoning de la cuenta",
    children: [
      { id: "settings-verify", group: "AJUSTES", label: "○ Verificar", hint: "lo que ve el headless" },
      { id: "settings-sync", group: "AJUSTES", label: "▶ Sincronizar a mano…", hint: "abre Chrome visible" },
      { id: "hook.settings", hidden: true, label: "hook.settings" },
    ],
  },
  {
    id: "harness",
    group: "CONFIGURAR",
    label: "Harnesses…",
    hint: "chatgpt_ask en otras CLIs",
    children: [
      { id: "harness-list", group: "HARNESS", label: "≣ Detectar", hint: "cuales tienes y si ya lo tienen" },
      { id: "harness-install", group: "HARNESS", label: "▶ Instalar…", hint: "plan + confirmacion" },
      { id: "harness-uninstall", group: "HARNESS", label: "■ Quitar…", hint: "plan + confirmacion" },
      { id: "hook.harness", hidden: true, label: "hook.harness" },
    ],
  },
  {
    id: "canary",
    group: "CONFIGURAR",
    label: "Canario…",
    hint: "¿la captura sigue viva?",
    children: [
      { id: "canary-run", group: "CANARIO", label: "▶ Correr ahora", hint: "3 turnos reales" },
      { id: "canary-status", group: "CANARIO", label: "○ Ultimo resultado" },
      { id: "canary-schedule", group: "CANARIO", label: "⏲ Programar diario…", hint: "plan + confirmacion" },
      { id: "canary-unschedule", group: "CANARIO", label: "■ Desprogramar…", hint: "plan + confirmacion" },
      { id: "hook.canary", hidden: true, label: "hook.canary" },
    ],
  },
  {
    id: "models",
    group: "CONFIGURAR",
    label: "Modelos Codex…",
    hint: "catalogo web",
    children: [
      { id: "models-dry", group: "MODELOS", label: "○ Dry-run", hint: "no escribe" },
      { id: "models-apply", group: "MODELOS", label: "▶ Preparar perfil", hint: "privado; se activa con isymcp codex" },
      { id: "models-restore", group: "MODELOS", label: "↩ Restaurar" },
      { id: "hook.models", hidden: true, label: "hook.models" },
    ],
  },
  {
    id: "session",
    group: "CONFIGURAR",
    label: "Sesiones MCP…",
    hint: "carpetas que ChatGPT puede usar",
    children: [
      { id: "session-list", group: "SESION", label: "≣ Listar", hint: "solo fingerprint" },
      { id: "session-mint", group: "SESION", label: "▶ Nueva (read-only)…", hint: "el token se muestra una vez" },
      { id: "session-mint-write", group: "SESION", label: "▶ Nueva con escritura…", hint: "pide confirmacion" },
      { id: "session-revoke", group: "SESION", label: "■ Revocar…", hint: "token o fp" },
      { id: "session-cookies", group: "SESION", label: "Guardar cookies (legacy)" },
      { id: "hook.session", hidden: true, label: "hook.session" },
    ],
  },
  {
    id: "procs",
    group: "PROCESOS",
    label: "Server, panel y tunel…",
    hint: "cada pieza por separado",
    children: [
      { id: "server-start", group: "SERVER", label: "▶ Iniciar server", hint: "detached :8791" },
      { id: "server-stop", group: "SERVER", label: "■ Detener server" },
      { id: "panel-start", group: "PANEL", label: "▶ Iniciar panel", hint: "detached :8798, sin abrir" },
      { id: "panel-stop", group: "PANEL", label: "■ Detener panel" },
      { id: "tunnel-setup", group: "TUNEL", label: "⚙ Configurar túnel…", hint: "pega ID + API key; entrada oculta" },
      { id: "tunnel-connect", group: "TUNEL", label: "▶ Conectar tunel" },
      { id: "tunnel-stop", group: "TUNEL", label: "■ Detener tunel" },
      { id: "tunnel-status", group: "TUNEL", label: "○ Estado del tunel" },
      { id: "hook.server", hidden: true, label: "hook.server" },
      { id: "hook.tunnel", hidden: true, label: "hook.tunnel" },
    ],
  },
  {
    id: "logs",
    group: "PROCESOS",
    label: "Logs…",
    hint: "ver y descargar",
    children: [
      { id: "logs-50", group: "LOGS", label: "≣ Ultimos 50" },
      { id: "logs-20", group: "LOGS", label: "≣ Ultimos 20" },
      { id: "logs-all", group: "LOGS", label: "↓ Descargar todos" },
      { id: "logs-window", group: "LOGS", label: "↓ Descargar por fecha…" },
      { id: "hook.logs", hidden: true, label: "hook.logs" },
    ],
  },
  { id: "quit", group: "SALIR", label: "Salir" },
  { id: "hook.root", hidden: true, label: "hook.root" },
];

export function visible(items: MenuItem[]): MenuItem[] {
  return items.filter((item) => !item.hidden);
}

export function findItem(id: string, items: MenuItem[] = MENU): MenuItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const child = item.children ? findItem(id, item.children) : undefined;
    if (child) return child;
  }
  return undefined;
}

/** Ids de hooks: estan en el arbol y no aparecen en ninguna etiqueta visible. */
export function hiddenHookIds(items: MenuItem[] = MENU): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.hidden) out.push(item.id);
    if (item.children) out.push(...hiddenHookIds(item.children));
  }
  return out;
}

export function visibleLabels(items: MenuItem[] = visible(MENU)): string[] {
  const out: string[] = [];
  for (const item of visible(items)) {
    out.push(item.label);
    if (item.children) out.push(...visibleLabels(item.children));
  }
  return out;
}

const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  gold: "\x1b[38;5;220m",
  purple: "\x1b[38;5;141m",
  inverse: "\x1b[7m",
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
};
const paint = (text: string, ...codes: string[]) =>
  USE_COLOR && codes.length ? codes.join("") + text + C.reset : text;

export function brandHeader(): string {
  const inner = 54;
  const row = (text: string, ...codes: string[]) => {
    const content = `  ${text}`;
    return `${paint("│", C.gold)}${paint(content, ...codes)}${" ".repeat(Math.max(0, inner - content.length))}${paint("│", C.gold)}`;
  };
  return [
    paint(`╭${"─".repeat(inner)}╮`, C.gold, C.bold),
    row("◆ CODEX ISYMCP", C.bold, C.cyan),
    row("BRIDGE · PANEL · CHAT · HARNESSES · CANARIO", C.dim),
    row("una sola entrada: isymcp", C.bold, C.purple),
    paint(`╰${"─".repeat(inner)}╯`, C.gold, C.bold),
  ].join("\n");
}

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

function menuCharWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(ch) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (/\p{Emoji_Presentation}/u.test(ch)) return 2;
  return cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60)) ? 2 : 1;
}

/** Recorta una línea (con ANSI) a `maxCols` columnas visibles para que nunca envuelva y rompa el cursor-up. */
export function clipMenuLine(line: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  let used = 0;
  let out = "";
  let hasAnsi = false;
  const tokens = line.match(/\x1b\[[0-?]*[ -/]*[@-~]|[\s\S]/gu) ?? [];
  for (const tok of tokens) {
    if (tok.startsWith("\x1b[")) {
      out += tok;
      hasAnsi = true;
      continue;
    }
    const w = menuCharWidth(tok);
    if (used + w > maxCols) break;
    out += tok;
    used += w;
  }
  return hasAnsi ? `${out}${C.reset}` : out;
}

export function select(message: string, choices: MenuItem[]): Promise<number> {
  const shown = visible(choices);
  if (shown.length === 0) return Promise.resolve(-1);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let idx = 0;
    let done = false;
    let buf = "";
    let prevRenderedLines = 0;

    // Construir filas lógicas (encabezados de grupo + opciones) para poder paginar sin desbordar la terminal.
    type Row = { kind: "group"; text: string } | { kind: "item"; index: number; choice: MenuItem };
    const rows: Row[] = [];
    let prevGroup: string | undefined;
    shown.forEach((choice, i) => {
      if (choice.group && choice.group !== prevGroup) {
        rows.push({ kind: "group", text: `  ${choice.group}` });
        prevGroup = choice.group;
      }
      rows.push({ kind: "item", index: i, choice });
    });

    const cleanup = () => {
      stdin.removeListener("data", onData);
      process.stdout.removeListener("resize", onResize);
      process.removeListener("SIGINT", onSigInt);
      process.removeListener("SIGTERM", onSigTerm);
      process.removeListener("exit", onExit);
      try { if (stdin.isTTY) stdin.setRawMode(false); } catch { /* noop */ }
      try { stdin.pause(); } catch { /* noop */ }
      try { process.stdout.write(`${C.reset}${C.show}`); } catch { /* noop */ }
    };
    const finish = (value: number) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };
    const onExit = () => {
      try { if (stdin.isTTY) stdin.setRawMode(false); } catch { /* noop */ }
      try { process.stdout.write(`${C.reset}${C.show}`); } catch { /* noop */ }
    };
    const onSigInt = () => { finish(-1); process.exit(130); };
    const onSigTerm = () => { finish(-1); process.exit(143); };

    const render = () => {
      const cols = Math.max(20, (process.stdout.columns || 80) - 1);
      const termRows = Math.max(8, process.stdout.rows || 24);
      // Reservar 3 filas (título, pie, holgura para que nunca haga scroll ni choque arriba).
      const maxBody = Math.max(3, termRows - 3);
      const activeRow = rows.findIndex((r) => r.kind === "item" && r.index === idx);

      let start = 0;
      let end = rows.length;
      if (rows.length > maxBody) {
        const bodySlots = Math.max(1, maxBody - 2); // dejar sitio para indicadores ▲/▼
        start = Math.min(Math.max(0, activeRow - Math.floor(bodySlots / 2)), Math.max(0, rows.length - bodySlots));
        end = Math.min(rows.length, start + bodySlots);
      }

      const lines: string[] = [paint(message, C.bold)];
      if (start > 0) lines.push(paint(`  ▲ ${start} más arriba`, C.dim));
      for (let r = start; r < end; r++) {
        const row = rows[r]!;
        if (row.kind === "group") {
          lines.push(paint(row.text, C.bold, C.purple));
        } else {
          const mark = row.index === idx ? paint("❯", C.cyan, C.bold) : " ";
          const lab = row.index === idx ? paint(row.choice.label, C.inverse) : row.choice.label;
          const hint = row.choice.hint ? paint(`  ${row.choice.hint}`, C.dim) : "";
          lines.push(`${mark} ${lab}${hint}`);
        }
      }
      if (end < rows.length) lines.push(paint(`  ▼ ${rows.length - end} más abajo`, C.dim));
      lines.push(paint("↑↓/jk navegar · PgUp/PgDn · Enter elegir · Esc/q salir", C.dim));

      const moveUp = prevRenderedLines > 0 ? `\x1b[${prevRenderedLines}A\r` : "\r";
      const body = lines.map((l) => `${clipMenuLine(l, cols)}\x1b[K`).join("\n");
      process.stdout.write(`${SYNC_START}${moveUp}${body}\n\x1b[0J${SYNC_END}`);
      prevRenderedLines = lines.length;
    };

    const onResize = () => { if (!done) render(); };
    const move = (delta: number) => {
      idx = ((idx + delta) % shown.length + shown.length) % shown.length;
      render();
    };

    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString("utf8");
      while (buf.length > 0 && !done) {
        if (buf[0] === "\u0003") { finish(-1); process.exit(130); return; }
        // Secuencias CSI: \x1b[ ... <final @-~>
        if (buf.startsWith("\x1b[")) {
          const match = buf.match(/^\x1b\[([0-?]*[ -/]*[@-~])/);
          if (!match) {
            // Secuencia incompleta todavía en tránsito (o basura muy larga)
            if (buf.length > 32) { buf = ""; }
            return;
          }
          const seq = match[1]!;
          buf = buf.slice(match[0].length);
          const final = seq[seq.length - 1]!;
          if (final === "A") move(-1);
          else if (final === "B") move(1);
          else if (final === "H" || seq === "1~" || seq === "7~") { idx = 0; render(); }
          else if (final === "F" || seq === "4~" || seq === "8~") { idx = shown.length - 1; render(); }
          else if (seq === "5~") { idx = Math.max(0, idx - 6); render(); }
          else if (seq === "6~") { idx = Math.min(shown.length - 1, idx + 6); render(); }
          // Ratón / teclas no usadas: se descartan limpiamente sin romper el menú.
          continue;
        }
        // Secuencias SS3 (tmux / application cursor mode): \x1bO<char>
        if (buf.startsWith("\x1bO")) {
          if (buf.length < 3) return;
          const code = buf[2];
          buf = buf.slice(3);
          if (code === "A") move(-1);
          else if (code === "B") move(1);
          else if (code === "H") { idx = 0; render(); }
          else if (code === "F") { idx = shown.length - 1; render(); }
          continue;
        }
        // Escape suelto
        if (buf[0] === "\x1b") {
          buf = buf.slice(1);
          finish(-1);
          return;
        }
        const ch = buf[0]!;
        buf = buf.slice(1);
        if (ch === "\r" || ch === "\n") { finish(idx); return; }
        if (ch === "q" || ch === "Q") { finish(-1); return; }
        if (ch === "k") move(-1);
        else if (ch === "j") move(1);
        else if (ch === "g") { idx = 0; render(); }
        else if (ch === "G") { idx = shown.length - 1; render(); }
      }
    };

    try { stdin.setRawMode(true); } catch { resolve(-1); return; }
    stdin.resume();
    stdin.on("data", onData);
    process.stdout.on("resize", onResize);
    process.once("SIGINT", onSigInt);
    process.once("SIGTERM", onSigTerm);
    process.once("exit", onExit);
    process.stdout.write(C.hide);
    render();
  });
}
