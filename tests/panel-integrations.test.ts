// panel-integrations.test.ts — el panel refleja las tareas de Codex (M8) y el
// canario, sin filtrar el contenido privado de las tareas.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCodexTasks } from "../src/codex-tasks";
import { buildPanelState, renderMain } from "../src/panel";

let home: string;
let dir: string;
const SECRET = "TEXTO-PRIVADO-DEL-TRANSCRIPT";
const url = (n: string) => `https://chatgpt.com/c/${n}0000000-aaaa-bbbb-cccc-dddddddddddd`;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "isymcp-panel-int-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
  dir = join(home, "codex-responses");
  mkdirSync(dir, { recursive: true });
  const input = [
    { role: "user", text: SECRET },
    { role: "assistant", text: SECRET },
    { role: "user", text: SECRET },
    { role: "assistant", text: SECRET },
  ];
  writeFileSync(join(dir, "task-aaaaaaaaaaaaaaaa.json"), JSON.stringify({ url: url("a"), input, instructions: SECRET }));
  writeFileSync(join(dir, "task-bbbbbbbbbbbbbbbb.json"), JSON.stringify({ url: url("b"), input: input.slice(0, 2), instructions: "", pending: "turn-9" }));
  writeFileSync(join(dir, "task-cccccccccccccccc.json"), JSON.stringify({ url: url("c"), input: [], instructions: "" }));
  writeFileSync(join(dir, "lease-cccccccccccccccc"), "");
  writeFileSync(join(dir, "task-dddddddddddddddd.json"), "{roto");
  writeFileSync(join(dir, "turn-xyz.json"), JSON.stringify({ phase: "done" }));
});
afterAll(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("tareas de Codex en el panel", () => {
  test("estados: lista, bloqueada (pending), en curso (lease), ilegible", () => {
    const by = Object.fromEntries(listCodexTasks(dir).map((t) => [t.id, t]));
    expect(by["aaaaaaaaaaaa"]).toMatchObject({ state: "lista", turns: 2, conversation: url("a") });
    expect(by["bbbbbbbbbbbb"]).toMatchObject({ state: "bloqueada", turns: 1 });
    expect(by["cccccccccccc"]).toMatchObject({ state: "en curso", turns: 0 });
    expect(by["dddddddddddd"]).toMatchObject({ state: "ilegible" });
    expect(Object.keys(by)).toHaveLength(4); // los turn-*.json no son tareas
  });

  test("el panel muestra metadatos y la nota de bloqueo, NUNCA el transcript", async () => {
    const html = renderMain(await buildPanelState("59999"));
    expect(html).toContain("TAREAS DE CODEX");
    expect(html).toContain("bloqueada");
    expect(html).toContain("no se reenvía solo");
    expect(html).not.toContain(SECRET);
  });

  test("canario: boton de correr y estado de programacion", async () => {
    const html = renderMain(await buildPanelState("59999"));
    expect(html).toContain('data-action="canary-run"');
    expect(html).toMatch(/Programado: todos los días 09:00|Sin programar|<p class="small muted"><\/p>/);
  });
});
