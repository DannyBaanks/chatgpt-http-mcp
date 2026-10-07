// dom-markdown.test.ts — DOM renderizado de ChatGPT -> Markdown (arbol falso
// con la interfaz minima que usa domToMarkdown dentro de la pagina).
import { describe, expect, test } from "bun:test";
import { domToMarkdown, markdownMatchesText, type MiniNode } from "../src/dom-markdown";
import { renderMarkdown } from "../src/markdown";

const txt = (s: string): MiniNode => ({ nodeType: 3, textContent: s, childNodes: [] });
function h(tagName: string, attrs: Record<string, string>, ...children: Array<MiniNode | string>): MiniNode {
  const childNodes = children.map((c) => (typeof c === "string" ? txt(c) : c));
  return {
    nodeType: 1, tagName: tagName.toUpperCase(), childNodes,
    className: attrs.class ?? "",
    getAttribute: (n) => attrs[n] ?? null,
    get textContent() { return childNodes.map((c) => c.textContent ?? "").join(""); },
  };
}

describe("domToMarkdown", () => {
  test("respuesta tipica de ChatGPT: parrafo, lista, bloque de codigo con su cabecera", () => {
    const dom = h("div", { class: "markdown prose" },
      h("p", {}, "PONG ", h("strong", {}, "listo"), " y ", h("code", {}, "x<y"), " ", h("a", { href: "https://ok.example/a" }, "link")),
      h("ul", {}, h("li", {}, "uno"), h("li", {}, h("p", {}, "dos"))),
      h("ol", { start: "3" }, h("li", {}, "tres")),
      h("pre", {}, h("div", {}, h("div", {}, "bash"), h("button", {}, "Copiar código")), h("div", {}, h("code", { class: "hljs language-bash" }, "echo hola\n"))),
      h("h2", {}, "Titulo"),
      h("blockquote", {}, h("p", {}, "cita")),
      h("p", {}, h("a", { href: "javascript:alert(1)" }, "malo")),
    );
    const md = domToMarkdown(dom);
    expect(md).toBe([
      "PONG **listo** y `x<y` [link](https://ok.example/a)",
      "",
      "- uno\n- dos",
      "",
      "3. tres",
      "",
      "```bash\necho hola\n```",
      "",
      "## Titulo",
      "",
      "> cita",
      "",
      "malo",
    ].join("\n"));
    // Y el renderizador seguro lo pinta sin HTML del modelo.
    const html = renderMarkdown(md);
    expect(html).toContain("<li>uno</li>");
    expect(html).toContain('<pre data-lang="bash"><code>echo hola</code></pre>');
    expect(html).toContain("<code>x&lt;y</code>");
    expect(html).not.toContain("javascript:");
  });

  test("markdownMatchesText evita usar un markdown de otro turno", () => {
    expect(markdownMatchesText("- uno\n- dos\n```bash\necho hola\n```", "uno\ndos\nBash\necho hola")).toBe(true);
    expect(markdownMatchesText("respuesta vieja de otro turno", "respuesta nueva")).toBe(false);
    expect(markdownMatchesText("", "x")).toBe(false);
    // <ol>: innerText no trae los numeros (CSS), el markdown si.
    expect(markdownMatchesText("1. Etiopia, siglo IX.\n2. Yemen y los sufies.", "Etiopia, siglo IX.\nYemen y los sufies.")).toBe(true);
  });

  test("corre igual tras toString (asi va a la pagina)", () => {
    const fn = new Function(`return (${domToMarkdown.toString()})`)() as typeof domToMarkdown;
    const dom = h("div", {}, h("p", {}, "a ", h("em", {}, "b")), h("ul", {}, h("li", {}, "c")));
    expect(fn(dom)).toBe(domToMarkdown(dom));
  });
});

describe("UI de ChatGPT 2026-10 (DOM real volcado)", () => {
  test("lista con spans + CodeBlock con cabecera 'Bash' y pre sin clase", () => {
    const dom = h("div", { "data-markdown-text-style": "assistant-message" },
      h("ul", { class: "List-kOVW5V UnorderedList-nqKD7g" }, h("li", { class: "ListItem-ncLgmg" }, h("span", {}, "uno")), h("li", { class: "ListItem-ncLgmg" }, h("span", {}, "dos"))),
      h("div", { class: "CodeBlock-zu1QM3" },
        h("div", { "data-markdown-copy": "code-block" },
          h("div", { "data-markdown-copy": "exclude" }, h("svg", {}), h("div", {}, "Bash"), h("button", { "aria-label": "Copiar" })),
          h("div", {}, h("pre", {}, h("code", {}, h("span", {}, "echo"), h("span", {}, " hola")))),
          h("button", { "aria-hidden": "true" }))));
    expect(domToMarkdown(dom)).toBe("- uno\n- dos\n\n```bash\necho hola\n```");
  });
});
