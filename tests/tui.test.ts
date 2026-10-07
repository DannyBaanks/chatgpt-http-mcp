import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpencodeModels, buildOpencodePatch, detectTuis, installIntoOpencode } from "../src/tui";

describe("detectTuis", () => {
  test("inventario con home sintetico", () => {
    const home = mkdtempSync(join(tmpdir(), "tui-home-"));
    const found = detectTuis(home);
    expect(found.length).toBeGreaterThan(5);
    expect(found.every((t) => t.id && t.label)).toBe(true);
    // el binario puede resolverse por PATH real; lo estable es el conjunto instalable
    expect(found.filter((t) => t.installable).map((t) => t.id)).toEqual(["opencode"]);
  });

  // Afirmacion sobre el host de desarrollo (Danny tiene opencode). En CI no hay
  // opencode: ahi se salta (se ve como skip, no como pass en falso). La logica de
  // deteccion la cubre el test de arriba con un home sintetico.
  const hostHasOpencode = existsSync(join(homedir(), ".config", "opencode")) || Boolean(Bun.which("opencode"));
  test.skipIf(!hostHasOpencode)("el host real detecta opencode como presente", () => {
    const found = detectTuis();
    expect(found.find((t) => t.id === "opencode")?.present).toBe(true);
  });
});

describe("buildOpencodePatch", () => {
  test("provider openai-compatible con filas web y MCP local", () => {
    const patch = buildOpencodePatch("http://127.0.0.1:8791", "/x/src/mcp/main.ts", "sol");
    const provider = patch.provider["isyco-web"] as Record<string, unknown>;
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect((provider.options as Record<string, unknown>).baseURL).toBe("http://127.0.0.1:8791/v1");
    const models = (provider as { models: Record<string, { name: string; limit: { context: number } }> }).models;
    expect(Object.keys(models).length).toBeGreaterThan(0);
    expect(Object.keys(models).every((slug) => slug.startsWith("chatgpt-web/"))).toBe(true);
    expect(Object.keys(models)).toEqual(["chatgpt-web/gpt-5.6-sol"]);
    expect(models["chatgpt-web/gpt-5.6-sol"].limit.context).toBeGreaterThan(0);
    const mcp = patch.mcp["isyco-web-http"] as Record<string, unknown>;
    expect(mcp.type).toBe("local");
    expect(mcp.command).toEqual(["bun", "/x/src/mcp/main.ts", "--contract", "native"]);
  });
});

describe("installIntoOpencode", () => {
  test("dry-run no escribe; apply con backup; restore vuelve", () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-install-"));
    const configPath = join(dir, "opencode.json");
    const backupsDir = join(dir, "backups");
    const opts = { configPath, backupsDir, baseUrl: "http://127.0.0.1:8791", mcpMain: "/x/main.ts", capsRaw: "sol" };
    const dry = installIntoOpencode({ ...opts, dryRun: true });
    expect(dry.action).toBe("dry-run");
    expect(existsSync(configPath)).toBe(false);
    const applied = installIntoOpencode({ ...opts, dryRun: false });
    expect(applied.action).toBe("apply");
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.provider["isyco-web"].models["chatgpt-web/gpt-5.6-sol"].name).toBe("GPT-5.6 Sol (Web)");
    const restored = installIntoOpencode({ ...opts, dryRun: false, restore: true });
    expect(restored.action).toBe("restore");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({});
  });

  test("preserva claves ajenas del config existente", () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-merge-"));
    const configPath = join(dir, "opencode.json");
    writeFileSync(configPath, JSON.stringify({ model: "otro/prov", provider: { otro: { models: {} } } }));
    installIntoOpencode({ configPath, backupsDir: join(dir, "b"), baseUrl: "http://127.0.0.1:8791", mcpMain: "/x/main.ts", capsRaw: "sol", dryRun: false });
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.model).toBe("otro/prov");
    expect(written.provider.otro).toBeTruthy();
    expect(written.provider["isyco-web"]).toBeTruthy();
  });
});
