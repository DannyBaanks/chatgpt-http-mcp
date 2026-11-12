import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpencodeModels,
  buildOpencodePatch,
  detectTuis,
  installIntoOpencode,
  installIntoTui,
  installIntoAllTuis,
} from "../src/tui";

describe("detectTuis", () => {
  test("inventario con home sintetico", () => {
    const home = mkdtempSync(join(tmpdir(), "tui-home-"));
    const found = detectTuis(home);
    expect(found.length).toBeGreaterThan(5);
    expect(found.every((t) => t.id && t.label)).toBe(true);
    // el binario puede resolverse por PATH real; lo estable es el conjunto instalable
    const installable = found.filter((t) => t.installable).map((t) => t.id);
    expect(installable).toContain("opencode");
    expect(installable).toContain("gemini");
    expect(installable).toContain("agy");
    expect(installable).toContain("openisy");
    expect(installable).toContain("claude");
    expect(installable).toContain("cursor");
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
  test("provider openai-compatible con filas web; el MCP ya no va en el parche", () => {
    const patch = buildOpencodePatch("http://127.0.0.1:8791", "sol");
    const provider = patch.provider["isyco-web"] as Record<string, unknown>;
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect((provider.options as Record<string, unknown>).baseURL).toBe("http://127.0.0.1:8791/v1");
    const models = (provider as { models: Record<string, { name: string; limit: { context: number } }> }).models;
    expect(Object.keys(models).length).toBeGreaterThan(0);
    expect(Object.keys(models).every((slug) => slug.startsWith("chatgpt-web/"))).toBe(true);
    expect(Object.keys(models)).toEqual(["chatgpt-web/gpt-5.6-sol"]);
    expect(models["chatgpt-web/gpt-5.6-sol"].limit.context).toBeGreaterThan(0);
    // El MCP lo instala solo src/harness.ts (--server gateway).
    expect(Object.keys(patch)).toEqual(["provider"]);
  });
});

describe("installIntoOpencode", () => {
  test("dry-run no escribe; apply con backup; restore vuelve", () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-install-"));
    const configPath = join(dir, "opencode.json");
    const backupsDir = join(dir, "backups");
    const opts = { configPath, backupsDir, baseUrl: "http://127.0.0.1:8791", capsRaw: "sol" };
    const dry = installIntoOpencode({ ...opts, dryRun: true });
    expect(dry.action).toBe("dry-run");
    expect(existsSync(configPath)).toBe(false);
    const applied = installIntoOpencode({ ...opts, dryRun: false });
    expect(applied.action).toBe("apply");
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.provider["isyco-web"].models["chatgpt-web/gpt-5.6-sol"].name).toBe("GPT-5.6 Sol (Web)");
    expect(written.mcp).toBeUndefined();
    const restored = installIntoOpencode({ ...opts, dryRun: false, restore: true });
    expect(restored.action).toBe("restore");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({});
  });

  test("preserva claves ajenas del config existente", () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-merge-"));
    const configPath = join(dir, "opencode.json");
    writeFileSync(configPath, JSON.stringify({ model: "otro/prov", provider: { otro: { models: {} } } }));
    installIntoOpencode({ configPath, backupsDir: join(dir, "b"), baseUrl: "http://127.0.0.1:8791", capsRaw: "sol", dryRun: false });
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.model).toBe("otro/prov");
    expect(written.provider.otro).toBeTruthy();
    expect(written.provider["isyco-web"]).toBeTruthy();
  });
});

describe("installIntoTui & installIntoAllTuis", () => {
  test("tui install solo escribe el provider de opencode/openisy; el MCP de TODAS va por harness", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "fake-home-"));
    const backupsDir = join(fakeHome, "backups");
    const run = (tuiId: string, dryRun = false) => installIntoTui({ tuiId, home: fakeHome, backupsDir, dryRun });

    // openisy -> provider en ~/.openisy/config/opencode.json (bin/openisy exporta OPENCODE_CONFIG_DIR ahí), MCP por harness
    const oi = run("openisy");
    expect(oi.configPath).toBe(join(fakeHome, ".openisy", "config", "opencode.json"));
    expect(oi.harness).toBe(true);
    const oiCfg = JSON.parse(readFileSync(oi.configPath, "utf8"));
    expect(oiCfg.provider["isyco-web"]).toBeDefined();
    expect(oiCfg.mcp).toBeUndefined();
    expect(existsSync(join(fakeHome, ".config", "opencode", "opencode.json"))).toBe(false);

    // opencode sigue en ~/.config/opencode, con su propio journal de backup
    expect(run("opencode").configPath).toBe(join(fakeHome, ".config", "opencode", "opencode.json"));
    expect(existsSync(join(backupsDir, "openisy", "tui-latest.json"))).toBe(true);
    expect(existsSync(join(backupsDir, "opencode", "tui-latest.json"))).toBe(true);

    // Todas las demás: tui install NO escribe nada; harness instala con su estrategia verificada.
    for (const id of ["agy", "antigravity", "gemini", "claude", "cursor", "desktop", "kimi", "crush"]) {
      const r = run(id);
      expect(r.harness).toBe(true);
      expect(r.action).toBe("noop");
      expect(r.models).toBe(0);
    }
    for (const f of [join(".gemini", "config", "mcp_config.json"), join(".gemini", "settings.json"), join(".claude", "claude_desktop_config.json"),
      join(".config", "Claude", "claude_desktop_config.json"), join(".cursor", "mcp.json")]) {
      expect(existsSync(join(fakeHome, f))).toBe(false);
    }
    // Las rutas que informa siguen siendo las reales (las mismas que usa harness).
    expect(run("gemini").configPath).toBe(join(fakeHome, ".gemini", "settings.json"));
    expect(run("agy").configPath).toBe(join(fakeHome, ".gemini", "config", "mcp_config.json"));
    expect(run("desktop").configPath).toBe(join(fakeHome, ".config", "Claude", "claude_desktop_config.json"));

    expect(() => run("nonexistent_tui_999")).toThrow("TUI desconocida");
  });

  test("installIntoAllTuis procesa todas las TUIs registradas", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "fake-home-all-"));
    const results = installIntoAllTuis({ home: fakeHome, backupsDir: join(fakeHome, "backups"), dryRun: false });
    expect(results.length).toBeGreaterThan(5);
    expect(results.every((r) => r.result?.action === "apply" || r.result?.action === "noop")).toBe(true);
    expect(results.every((r) => r.result?.harness === true)).toBe(true);
  });
});
