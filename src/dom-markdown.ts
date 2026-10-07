// dom-markdown.ts — reconstruye Markdown desde el DOM ya renderizado de una
// respuesta de ChatGPT (innerText pierde listas, bloques de codigo, enlaces).
//
// Corre DENTRO de la pagina de ChatGPT (page.evaluate con toString), asi que
// es autocontenida y solo usa la interfaz minima de nodos (nodeType, tagName,
// childNodes, textContent, getAttribute, className). Eso tambien permite
// probarla en bun con un arbol falso.
//
// Es SOLO presentacion para el chat local: `text` (innerText) sigue siendo lo
// que devuelve el bridge a /v1/* y lo que verifican los soaks.
export interface MiniNode {
  nodeType: number;
  tagName?: string;
  textContent: string | null;
  childNodes: ArrayLike<MiniNode>;
  getAttribute?: (name: string) => string | null;
  className?: unknown;
}

export function domToMarkdown(root: MiniNode): string {
  const kids = (n: MiniNode): MiniNode[] => Array.from(n.childNodes ?? []);
  const tag = (n: MiniNode) => (n.tagName ?? "").toLowerCase();
  const attr = (n: MiniNode, a: string) => (n.getAttribute ? n.getAttribute(a) : null) ?? "";
  const SKIP = new Set(["button", "svg", "style", "script", "noscript", "img", "video", "audio", "canvas"]);

  const inline = (n: MiniNode): string => {
    if (n.nodeType === 3) return (n.textContent ?? "").replace(/\s+/g, " ");
    if (n.nodeType !== 1) return "";
    const t = tag(n);
    if (SKIP.has(t) || attr(n, "data-markdown-copy") === "exclude" || attr(n, "aria-hidden") === "true") return "";
    const inner = () => kids(n).map(inline).join("");
    if (t === "br") return "\n";
    if (t === "strong" || t === "b") { const s = inner().trim(); return s ? `**${s}**` : ""; }
    if (t === "em" || t === "i") { const s = inner().trim(); return s ? `*${s}*` : ""; }
    if (t === "code") { const s = (n.textContent ?? "").replace(/`/g, "'"); return s ? `\`${s}\`` : ""; }
    if (t === "a") {
      const href = attr(n, "href");
      const s = inner().trim();
      return /^https?:\/\//.test(href) ? `[${s || href}](${href})` : s;
    }
    return inner();
  };

  const block = (n: MiniNode, indent: string): string => {
    if (n.nodeType === 3) { const s = (n.textContent ?? "").trim(); return s ? `${indent}${s.replace(/\s+/g, " ")}\n\n` : ""; }
    if (n.nodeType !== 1) return "";
    const t = tag(n);
    if (SKIP.has(t) || attr(n, "data-markdown-copy") === "exclude" || attr(n, "aria-hidden") === "true") return "";
    if (/^h[1-6]$/.test(t)) return `${indent}${"#".repeat(Number(t[1]))} ${kids(n).map(inline).join("").trim()}\n\n`;
    if (t === "p") { const s = kids(n).map(inline).join("").trim(); return s ? `${indent}${s.replace(/\n/g, `\n${indent}`)}\n\n` : ""; }
    if (t === "hr") return `${indent}---\n\n`;
    // Bloque de codigo de la UI actual (2026-10): div.CodeBlock-* con una
    // cabecera data-markdown-copy="exclude" (lenguaje + botones) y un <pre>.
    if (/(^|\s)CodeBlock-/.test(String(n.className ?? ""))) {
      const findBy = (x: MiniNode, ok: (y: MiniNode) => boolean): MiniNode | null => {
        if (x.nodeType === 1 && ok(x)) return x;
        for (const k of kids(x)) { const f = findBy(k, ok); if (f) return f; }
        return null;
      };
      const header = findBy(n, (y) => attr(y, "data-markdown-copy") === "exclude");
      const pre = findBy(n, (y) => tag(y) === "pre");
      if (pre) {
        const lang = (header?.textContent ?? "").trim().toLowerCase().replace(/[^\w.+-]/g, "");
        const code = findBy(pre, (y) => tag(y) === "code") ?? pre;
        return `${indent}\`\`\`${lang}\n${(code.textContent ?? "").replace(/\n$/, "")}\n${indent}\`\`\`\n\n`;
      }
    }
    if (t === "pre") {
      const find = (x: MiniNode): MiniNode | null => {
        if (x.nodeType === 1 && tag(x) === "code") return x;
        for (const k of kids(x)) { const f = find(k); if (f) return f; }
        return null;
      };
      const code = find(n) ?? n;
      const lang = /language-([\w.+-]+)/.exec(String(code.className ?? ""))?.[1] ?? "";
      const body = (code.textContent ?? "").replace(/\n$/, "");
      return `${indent}\`\`\`${lang}\n${body}\n${indent}\`\`\`\n\n`;
    }
    if (t === "blockquote") {
      const inner = kids(n).map((k) => block(k, "")).join("").trim();
      return `${inner.split("\n").map((l) => `${indent}> ${l}`).join("\n")}\n\n`;
    }
    if (t === "ul" || t === "ol") {
      let i = Number(attr(n, "start")) || 1;
      const lines: string[] = [];
      for (const li of kids(n)) {
        if (li.nodeType !== 1 || tag(li) !== "li") continue;
        const marker = t === "ol" ? `${i++}. ` : "- ";
        const parts: string[] = [];
        const nested: string[] = [];
        for (const k of kids(li)) {
          const kt = k.nodeType === 1 ? tag(k) : "";
          if (kt === "ul" || kt === "ol") nested.push(block(k, `${indent}  `).replace(/\n+$/, ""));
          else if (kt === "p") parts.push(kids(k).map(inline).join("").trim());
          else parts.push(inline(k));
        }
        lines.push(`${indent}${marker}${parts.join(" ").replace(/\s+/g, " ").trim()}`);
        lines.push(...nested);
      }
      return `${lines.join("\n")}\n\n`;
    }
    if (t === "table") {
      const rows: string[] = [];
      const walk = (x: MiniNode) => {
        for (const k of kids(x)) {
          if (k.nodeType !== 1) continue;
          if (tag(k) === "tr") rows.push(kids(k).filter((c) => c.nodeType === 1).map((c) => inline(c).trim()).join(" | "));
          else walk(k);
        }
      };
      walk(n);
      return rows.length ? `${rows.map((r) => `${indent}${r}`).join("\n")}\n\n` : "";
    }
    // Contenedores (div, section, span suelto...): si solo hay inline, es un parrafo.
    const children = kids(n);
    const hasBlock = children.some((k) => k.nodeType === 1 && /^(p|div|pre|ul|ol|h[1-6]|blockquote|table|hr|section)$/.test(tag(k)));
    if (!hasBlock) { const s = children.map(inline).join("").trim(); return s ? `${indent}${s}\n\n` : ""; }
    return children.map((k) => block(k, indent)).join("");
  };

  return block(root, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Solo letras en minuscula, para comparar el markdown con innerText. Sin
 * digitos: los numeros de una <ol> salen de CSS y innerText no los trae,
 * pero el markdown si ("1. ").
 */
function letters(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}]+/gu, "");
}

/**
 * ¿El markdown reconstruido corresponde al mismo texto que innerText? Si no
 * (selector equivocado, DOM raro), el chat usa el texto plano.
 */
export function markdownMatchesText(markdown: string, text: string): boolean {
  const m = letters(markdown);
  const t = letters(text);
  if (!m || !t) return false;
  const probe = t.slice(0, 40);
  return m.includes(probe) && m.length <= t.length * 2 + 200;
}
