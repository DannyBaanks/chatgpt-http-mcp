// tests/cli-modules.test.ts — núcleo de la CLI: los comandos migrados se resuelven por el registro.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_MODULES, findCliModule } from "../src/cli/module";

const CLI = join(import.meta.dir, "..", "src", "isymcp.ts");

function runCli(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, "run", CLI, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

describe("núcleo de la CLI", () => {
  it("CM-01: nombres únicos y resolución por nombre", () => {
    const names = CLI_MODULES.flatMap((m) => m.names);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ["allow", "harness", "tui"]) expect(findCliModule(n)?.names).toContain(n);
    expect(findCliModule("no-existe")).toBeNull();
    expect(findCliModule(undefined)).toBeNull();
  });

  it("CM-02: `isymcp allow` corre por el módulo (home aislado)", () => {
    const home = mkdtempSync(join(tmpdir(), "cli-mod-"));
    try {
      const r = runCli(["allow"], { CODEX_WEB_HTTP_HOME: home });
      expect(r.code).toBe(0);
      expect(r.out).toContain("apagado   shell");
      expect(r.out).toContain("apagado   agents");
      const bad = runCli(["allow", "shell", "on", "--for", "30h"], { CODEX_WEB_HTTP_HOME: home });
      expect(bad.code).toBe(2);
      expect(bad.out).toContain("--for máximo 24h");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("CM-03: subcomando desconocido de un módulo muestra la ayuda global y sale con 2", () => {
    const r = runCli(["tui", "nonsense"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("isymcp tui spawn");
  });
});
