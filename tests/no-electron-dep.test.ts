// M2 del plan de cierre: separar los tres claims.
//   1) "Electron no se ejecuta"          -> operacional (bridge corre headless sin launcher)
//   2) "Electron no es dependencia/path" -> ESTE test (deps + imports)
//   3) "browser automation eliminada"    -> FALSO: Playwright es el adapter (control positivo)
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function codeLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"));
}

describe("M2: Electron fuera de este path", () => {
  test("package.json no declara electron en ninguna seccion de dependencias", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
    for (const section of sections) {
      const deps = (pkg[section] ?? {}) as Record<string, string>;
      const offenders = Object.keys(deps).filter((name) => /^electron(-|$)/.test(name));
      expect(offenders).toEqual([]);
    }
  });

  test("src/ y scripts/ no importan ni spawnean electron (comentarios historicos permitidos)", () => {
    const offenders: string[] = [];
    for (const file of [...tsFiles(join(ROOT, "src")), ...tsFiles(join(ROOT, "scripts"))]) {
      for (const line of codeLines(file)) {
        if (/\belectron\b/i.test(line)) offenders.push(`${file.slice(ROOT.length + 1)}: ${line.slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("control positivo: el web adapter real es Playwright (no Electron)", () => {
    const webTurn = readFileSync(join(ROOT, "src", "web-turn.ts"), "utf8");
    expect(webTurn).toContain('from "playwright-core"');
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toContain("playwright-core");
  });
});
