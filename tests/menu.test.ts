import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hiddenHookIds, visible, visibleLabels, MENU, type MenuItem } from "../src/menu";

function leaves(items: MenuItem[]): string[] {
  return visible(items).flatMap((item) => (item.children ? leaves(item.children) : [item.id]));
}

describe("menu", () => {
  test("el arbol tiene ramas hijo", () => {
    const parents = visible(MENU).filter((item) => item.children);
    expect(parents.map((item) => item.id).sort()).toEqual(["canary", "harness", "logs", "models", "procs", "session", "settings"]);
  });

  test("la puerta de entrada cubre panel, chat, ajustes, harnesses y canario", () => {
    const ids = leaves(MENU);
    for (const id of ["panel-open", "ask", "settings-verify", "settings-sync", "harness-install", "canary-run", "canary-schedule", "panel-stop"]) {
      expect(ids).toContain(id);
    }
  });

  test("cada hoja visible tiene accion en isymcp.ts (nada que no haga nada)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "isymcp.ts"), "utf8");
    const missing = leaves(MENU).filter((id) => id !== "quit" && !source.includes(`  "${id}": `));
    expect(missing).toEqual([]);
  });

  test("los hooks existen y no se ven", () => {
    const hooks = hiddenHookIds();
    expect(hooks).toContain("hook.root");
    expect(hooks).toContain("hook.logs");
    const labels = visibleLabels();
    for (const hook of hooks) {
      expect(labels.join("\n")).not.toContain(hook);
    }
  });
});
