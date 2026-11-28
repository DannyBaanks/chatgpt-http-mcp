// Marcado de chatgpt.com medido en vivo el 2026-11-27 (ver src/web-turn.ts, ASSISTANT_PRIMARY_SELECTOR):
//   - [data-testid^="conversation-turn-"] y [data-message-author-role] ya NO existen.
//   - El turno [data-content-search-turn-key] / [data-turn-key] envuelve el mensaje del usuario
//     Y la respuesta (su innerText empieza por "Tú dijiste:"), y ya no trae "ChatGPT dijo:".
//   - La respuesta vive sola en [data-response-body="<message-id>"] y en la unidad
//     [data-chatgpt-search-unit-key="<turn-key>:2:assistant"]; el texto está en
//     [data-markdown-text-style="assistant-message"].
// Ejecuta el lector REAL de web-turn.ts con solo el borde del navegador reemplazado.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractResponse, isNewAssistantTurn } from "../src/web-turn";

const source = readFileSync(join(import.meta.dir, "../src/web-turn.ts"), "utf8");
const readers = source.slice(source.indexOf("const ASSISTANT_PRIMARY_SELECTOR"), source.indexOf("/** Markdown de la ultima respuesta"));
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(readers.replace(/export /g, ""));
const reader = new Function("extractResponse", `${js}; return async (page) => typeof readLastAssistantSnapshot === 'function' ? readLastAssistantSnapshot(page) : { id: await lastAssistantIdentity(page), text: await readLastAssistant(page) };`)(extractResponse);

// ---- DOM mínimo que respeta selectores y atributos -------------------------------------------
type Attrs = Record<string, string>;
interface FakeNode {
  tagName: string; attrs: Attrs; children: FakeNode[]; text?: string;
  innerText: string;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): FakeNode[];
  querySelector(selector: string): FakeNode | null;
}
function el(tagName: string, attrs: Attrs = {}, children: FakeNode[] = [], text = ""): FakeNode {
  const node: FakeNode = {
    tagName, attrs, children, text,
    get innerText() {
      return [node.text, ...node.children.map((c) => c.innerText)].filter(Boolean).join("\n");
    },
    getAttribute: (name) => Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null,
    querySelectorAll: (selector) => query(node, selector, false),
    querySelector: (selector) => query(node, selector, false)[0] ?? null,
  };
  return node;
}
// Soporta: "a, b", "a[attr]", 'a[attr="v"]', 'a[attr^="v"]', 'a[attr$="v"]', "a:has(b)", "a:not(b *)".
function matches(node: FakeNode, part: string): boolean {
  const sel = part.trim();
  const notMatch = sel.match(/^(.*?):not\((.*)\)$/);
  if (notMatch) return matches(node, notMatch[1]) && query(node, notMatch[2], true).length === 0;
  const hasMatch = sel.match(/^(.*?):has\((.*)\)$/);
  if (hasMatch) return matches(node, hasMatch[1]) && query(node, hasMatch[2], true).length > 0;
  const attrMatch = sel.match(/^([a-zA-Z]*)((?:\[[^\]]+\])*)$/);
  if (!attrMatch) return false;
  const [, tag, attrList] = attrMatch;
  if (tag && tag.toLowerCase() !== node.tagName.toLowerCase()) return false;
  for (const raw of attrList.matchAll(/\[([^\]=^$*]+)(?:([\^$*]?=)"?([^"\]]*)"?)?\]/g)) {
    const [, name, op, value] = raw;
    const actual = node.getAttribute(name);
    if (actual === null) return false;
    if (!op) continue;
    if (op === "=" && actual !== value) return false;
    if (op === "^=" && !actual.startsWith(value)) return false;
    if (op === "$=" && !actual.endsWith(value)) return false;
    if (op === "*=" && !actual.includes(value)) return false;
  }
  return true;
}
function query(root: FakeNode, selector: string, descendantsOnly: boolean): FakeNode[] {
  const out: FakeNode[] = [];
  const visit = (n: FakeNode, isRoot: boolean) => {
    if (!(isRoot && descendantsOnly) && selector.split(",").some((p) => matches(n, p))) out.push(n);
    for (const c of n.children) visit(c, false);
  };
  visit(root, true);
  return out;
}
function pageWith(root: FakeNode) {
  const previous = (globalThis as any).document;
  (globalThis as any).document = { querySelectorAll: (s: string) => query(root, s, true) };
  return { evaluate: async (fn: any, args: any) => { try { return fn(args); } finally { (globalThis as any).document = previous; } } };
}

// ---- Marcado real del 2026-11-27 -------------------------------------------------------------
const markdown = (text: string) => el("div", { "data-markdown-text-style": "assistant-message", class: "MarkdownRoot" }, [], text);
function turn20261127(messageId: string, answer: string | null, userText = "hazme un compose") {
  const unitUser = el("div", { "data-chatgpt-search-unit-key": "k:0:user", "data-conversation-role": "user" }, [], `hoy 14:18\nTú dijiste:\n${userText}`);
  const unitAssistant = el("div", { "data-chatgpt-search-unit-key": "k:2:assistant", "data-conversation-role": "assistant" }, [
    el("div", { "data-response-body": messageId }, answer === null ? [] : [markdown(answer)]),
  ]);
  return el("div", { "data-content-search-turn-key": "k", "data-turn-key": "k", "data-talvt-turn-state": "complete" }, [unitUser, unitAssistant]);
}

test("2026-11-27: la respuesta se lee del contenedor limpio, no del turno que incluye al usuario", async () => {
  const page = pageWith(turn20261127("7ab3f1ff-4300", "YAML # docker-compose\nservices: {}"));
  expect(await reader(page)).toEqual({ id: "7ab3f1ff-4300", text: "YAML # docker-compose\nservices: {}" });
});

test("2026-11-27: sin los testid ni data-message-author-role viejos, la identidad es data-response-body", async () => {
  const root = el("main", {}, [turn20261127("old-0001", "OLD"), turn20261127("new-0002", "NEW")]);
  const snapshot = await reader(pageWith(root));
  expect(snapshot.id).toBe("new-0002");
  expect(snapshot.text).toBe("NEW");
  expect(isNewAssistantTurn("old-0001", "OLD", snapshot.id, snapshot.text)).toBe(true);
});

test("2026-11-27: un turno nuevo sin respuesta todavia no hereda la anterior", async () => {
  const root = el("main", {}, [turn20261127("old-0001", "OLD"), turn20261127("new-0002", null)]);
  const snapshot = await reader(pageWith(root));
  expect(snapshot).toEqual({ id: "new-0002", text: "" });
  expect(isNewAssistantTurn("old-0001", "OLD", snapshot.id, snapshot.text)).toBe(false);
});

test("2026-11-27: la respuesta identica de otro mensaje cuenta como turno nuevo", async () => {
  const root = el("main", {}, [turn20261127("old-0001", "OK"), turn20261127("new-0002", "OK")]);
  const snapshot = await reader(pageWith(root));
  expect(snapshot).toEqual({ id: "new-0002", text: "OK" });
  expect(isNewAssistantTurn("old-0001", "OK", snapshot.id, snapshot.text)).toBe(true);
});
