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
  { id: "up", group: "PUENTE", label: "▶ Levantar todo", hint: "server + tunel + instalar en Codex" },
  { id: "down", group: "PUENTE", label: "■ Detener todo", hint: "cierre del server y del tunel" },
  { id: "restart", group: "PUENTE", label: "↻ Reiniciar", hint: "down + up" },
  { id: "status", group: "PUENTE", label: "○ Estado", hint: "server, tunel, mcp" },
  {
    id: "server",
    group: "SERVER",
    label: "Server…",
    hint: "proceso local :8791",
    children: [
      { id: "server-start", group: "SERVER", label: "▶ Iniciar", hint: "detached" },
      { id: "server-stop", group: "SERVER", label: "■ Detener" },
      { id: "hook.server", hidden: true, label: "hook.server" },
    ],
  },
  {
    id: "tunnel",
    group: "TUNEL",
    label: "Tunel…",
    hint: "openai tunnel-client",
    children: [
      { id: "tunnel-connect", group: "TUNEL", label: "▶ Conectar" },
      { id: "tunnel-stop", group: "TUNEL", label: "■ Detener" },
      { id: "tunnel-status", group: "TUNEL", label: "○ Estado" },
      { id: "hook.tunnel", hidden: true, label: "hook.tunnel" },
    ],
  },
  {
    id: "logs",
    group: "LOGS",
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
  {
    id: "models",
    group: "MODELOS",
    label: "Modelos Codex…",
    hint: "catalogo web",
    children: [
      { id: "models-dry", group: "MODELOS", label: "○ Dry-run", hint: "no escribe" },
      { id: "models-apply", group: "MODELOS", label: "▶ Aplicar", hint: "backup antes" },
      { id: "models-restore", group: "MODELOS", label: "↩ Restaurar" },
      { id: "hook.models", hidden: true, label: "hook.models" },
    ],
  },
  { id: "command", group: "CHATGPT", label: "Armar comando @…", hint: "texto para pegar" },
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
    row("BRIDGE LOCAL · TUNEL · LOGS · MODELOS", C.dim),
    row("SERVER · CHATGPT · HOOKS OCULTOS", C.bold, C.purple),
    paint(`╰${"─".repeat(inner)}╯`, C.gold, C.bold),
  ].join("\n");
}

export function select(message: string, choices: MenuItem[]): Promise<number> {
  const shown = visible(choices);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let idx = 0;
    let done = false;
    let buf = "";
    const groupCount = shown.reduce((n, c, i) => n + (c.group && c.group !== shown[i - 1]?.group ? 1 : 0), 0);
    const lineCount = () => shown.length + 2 + groupCount;
    const cleanup = () => {
      stdin.removeListener("data", onData);
      try { if (stdin.isTTY) stdin.setRawMode(false); } catch { /* noop */ }
      try { stdin.pause(); } catch { /* noop */ }
      process.stdout.write(C.show);
    };
    const finish = (value: number) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };
    const render = (first: boolean) => {
      let out = first ? "" : `\x1b[${lineCount()}A`;
      out += `${paint(message, C.bold)}\n`;
      let previous: string | undefined;
      shown.forEach((choice, i) => {
        if (choice.group && choice.group !== previous) {
          out += `${paint(`  ${choice.group}`, C.bold, C.purple)}\n`;
          previous = choice.group;
        }
        const mark = i === idx ? paint("❯", C.cyan, C.bold) : " ";
        const lab = i === idx ? paint(choice.label, C.inverse) : choice.label;
        const hint = choice.hint ? paint(`  ${choice.hint}`, C.dim) : "";
        out += `${mark} ${lab}${hint}\n`;
      });
      out += paint("↑↓ navegar · Enter elegir · Esc salir", C.dim) + "\n";
      out += "\x1b[0J";
      process.stdout.write(out);
    };
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (!buf.length) return;
        if (buf[0] === "\u0003") { finish(-1); process.exit(130); return; }
        if (buf.startsWith("\x1b[")) {
          if (buf.length < 3) return;
          const code = buf[2];
          buf = buf.slice(3);
          if (code === "A") idx = (idx - 1 + shown.length) % shown.length;
          else if (code === "B") idx = (idx + 1) % shown.length;
          render(false);
          continue;
        }
        if (buf[0] === "\x1b") { buf = buf.slice(1); finish(-1); return; }
        const ch = buf[0];
        buf = buf.slice(1);
        if (ch === "\r" || ch === "\n") { finish(idx); return; }
        if (ch === "q" || ch === "Q") { finish(-1); return; }
      }
    };
    try { stdin.setRawMode(true); } catch { resolve(-1); return; }
    stdin.resume();
    stdin.on("data", onData);
    process.stdout.write(C.hide);
    render(true);
  });
}
