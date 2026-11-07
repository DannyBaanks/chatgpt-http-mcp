import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpencodeModels,
  buildOpencodePatch,
  detectTuis,
  installIntoOpencode,
  installIntoStandardMcpTui,
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

describe("installIntoStandardMcpTui", () => {
  test("dry-run no escribe; apply inyecta mcpServers.isymcp; restore recupera", () => {
    const dir = mkdtempSync(join(tmpdir(), "std-mcp-"));
    const configPath = join(dir, "mcp_config.json");
    const backupsDir = join(dir, "backups");
    const opts = { configPath, backupsDir, mcpMain: "/path/to/main.ts", dryRun: true, tuiId: "gemini" };

    // Dry-run
    const dry = installIntoStandardMcpTui(opts);
    expect(dry.action).toBe("dry-run");
    expect(existsSync(configPath)).toBe(false);

    // Apply
    const applied = installIntoStandardMcpTui({ ...opts, dryRun: false });
    expect(applied.action).toBe("apply");
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.mcpServers?.isymcp).toBeDefined();
    expect(written.mcpServers.isymcp.command).toContain("bun");
    expect(written.mcpServers.isymcp.args).toContain("--contract");

    // Restore elimina el archivo si fue creado desde cero
    const restored = installIntoStandardMcpTui({ ...opts, dryRun: false, restore: true });
    expect(restored.action).toBe("restore");
    expect(existsSync(configPath)).toBe(false);
  });

  test("preserva servidores MCP preexistentes", () => {
    const dir = mkdtempSync(join(tmpdir(), "std-mcp-merge-"));
    const configPath = join(dir, "mcp.json");
    const initialConfig = {
      otherKey: "keep_me",
      mcpServers: {
        other_tool: { command: "python", args: ["script.py"] },
      },
    };
    writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));

    installIntoStandardMcpTui({
      configPath,
      backupsDir: join(dir, "backups"),
      mcpMain: "/path/to/main.ts",
      dryRun: false,
      tuiId: "cursor",
    });

    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    expect(updated.otherKey).toBe("keep_me");
    expect(updated.mcpServers.other_tool.command).toBe("python");
    expect(updated.mcpServers.isymcp.command).toContain("bun");
  });
});

describe("installIntoTui & installIntoAllTuis", () => {
  test("despacha correctamente a gemini, claude y opencode", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "fake-home-"));
    const backupsDir = join(fakeHome, "backups");

    const resGemini = installIntoTui({
      tuiId: "gemini",
      home: fakeHome,
      backupsDir,
      mcpMain: "/path/to/main.ts",
      dryRun: false,
    });
    expect(resGemini.action).toBe("apply");
    const geminiConfig = join(fakeHome, ".gemini", "config", "mcp_config.json");
    expect(existsSync(geminiConfig)).toBe(true);

    const resClaude = installIntoTui({
      tuiId: "claude",
      home: fakeHome,
      backupsDir,
      mcpMain: "/path/to/main.ts",
      dryRun: false,
    });
    expect(resClaude.action).toBe("apply");
    const claudeConfig = join(fakeHome, ".claude", "claude_desktop_config.json");
    expect(existsSync(claudeConfig)).toBe(true);

    // Alias 'openisy' resuelve a 'opencode'
    const resOpenIsy = installIntoTui({
      tuiId: "openisy",
      home: fakeHome,
      backupsDir,
      mcpMain: "/path/to/main.ts",
      dryRun: false,
    });
    expect(resOpenIsy.action).toBe("apply");
    expect(existsSync(join(fakeHome, ".config", "opencode", "opencode.json"))).toBe(true);

    // Alias 'agy' resuelve a 'gemini'
    const resAgy = installIntoTui({
      tuiId: "agy",
      home: fakeHome,
      backupsDir,
      mcpMain: "/path/to/main.ts",
      dryRun: true,
    });
    expect(resAgy.action).toBe("dry-run");

    // TUI desconocida lanza error
    expect(() => {
      installIntoTui({
        tuiId: "nonexistent_tui_999",
        home: fakeHome,
        backupsDir,
        mcpMain: "/path/to/main.ts",
        dryRun: false,
      });
    }).toThrow("TUI desconocida");
  });

  test("installIntoAllTuis procesa todas las TUIs registradas", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "fake-home-all-"));
    const results = installIntoAllTuis({
      home: fakeHome,
      backupsDir: join(fakeHome, "backups"),
      mcpMain: "/path/to/main.ts",
      dryRun: false,
    });

    expect(results.length).toBeGreaterThan(5);
    expect(results.every((r) => r.result?.action === "apply" || r.result?.action === "noop")).toBe(true);
  });
});
