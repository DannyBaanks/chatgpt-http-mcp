import { describe, expect, test } from "bun:test";
import { hiddenHookIds, visible, visibleLabels, MENU } from "../src/menu";

describe("menu", () => {
  test("el arbol tiene ramas hijo", () => {
    const parents = visible(MENU).filter((item) => item.children);
    expect(parents.map((item) => item.id).sort()).toEqual(["logs", "models", "server", "tunnel"]);
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
