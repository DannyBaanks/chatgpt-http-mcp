// markdown.ts — Markdown minimo y SEGURO para el chat del panel.
//
// Regla: todo el texto del modelo se escapa ANTES de transformarlo; las unicas
// etiquetas que salen son las que genera este archivo (p, br, h3-h5, ul/ol/li,
// blockquote, hr, pre/code, strong, em, a). Los enlaces solo aceptan http(s).
// No hay HTML crudo del modelo en ningun camino.
//
// La funcion es AUTOCONTENIDA (sin imports ni referencias externas) porque el
// panel la manda al navegador con renderMarkdown.toString(): el mismo codigo
// que pasan los tests es el que corre en la pagina.
export function renderMarkdown(source: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const inline = (raw: string): string => {
    const slots: string[] = [];
    const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
    let s = raw.replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code>${esc(code)}</code>`));
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
      hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`));
    s = s.replace(/https?:\/\/[^\s<>()\u0000]+[^\s<>().,;:!?'"\u0000]/g, (url) =>
      hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`));
    s = esc(s);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? "");
  };

  // \u0000 marca los huecos internos de inline(): no se acepta en la entrada.
  const lines = source.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```+|~~~+)\s*([\w.+-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!);
      i++;
      out.push(`<pre data-lang="${esc(lang)}"><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(5, heading[1]!.length + 2);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const ordered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line);
      const re = isOrdered ? ordered : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!)) {
        let item = lines[i++]!.replace(re, "");
        // continuacion indentada del mismo item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !bullet.test(lines[i]!) && !ordered.test(lines[i]!)) {
          item += ` ${lines[i++]!.trim()}`;
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(isOrdered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length && lines[i]!.trim()
      && !/^\s*(```+|~~~+)/.test(lines[i]!) && !/^#{1,6}\s/.test(lines[i]!)
      && !bullet.test(lines[i]!) && !ordered.test(lines[i]!) && !/^\s*>/.test(lines[i]!)
    ) para.push(lines[i++]!);
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}
