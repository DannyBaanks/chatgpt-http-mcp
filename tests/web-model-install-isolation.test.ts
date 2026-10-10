import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIsolatedCodexArgs, installWebModels } from "../scripts/install-web-models";
import { buildCodexArgs } from "../src/codex-launcher";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "isymcp-web-profile-"));
  const codexHome = join(root, "codex");
  const profileDir = join(root, "isolated");
  mkdirSync(codexHome);
  const configPath = join(codexHome, "config.toml");
  const cachePath = join(codexHome, "models_cache.json");
  const config = 'model = "gpt-6-luna"\nmodel_reasoning_effort = "medium"\n\n[mcp_servers.user]\ncommand = "user-mcp"\n';
  const cache = JSON.stringify({ models: [{
    slug: "gpt-6-luna", visibility: "list", supported_reasoning_levels: [{ effort: "high" }],
    opaque_native_setting: { preserve: true },
  }] });
  writeFileSync(configPath, config);
  writeFileSync(cachePath, cache);
  return { root, codexHome, profileDir, configPath, cachePath, config, cache };
}

test("models apply prepares an isolated provider and leaves native Codex bytes unchanged", () => {
  const f = fixture();
  const result = installWebModels({ ...f, apply: true, model: "chatgpt-web/gpt-5.6-sol", effort: "high" });
  expect(result.scope).toBe("isolated");
  expect(readFileSync(f.configPath, "utf8")).toBe(f.config);
  expect(readFileSync(f.cachePath, "utf8")).toBe(f.cache);
  const profile = JSON.parse(readFileSync(result.profilePath, "utf8"));
  expect(profile.enabled).toBe(true);
  expect(profile.provider).toMatchObject({ name: "ISyMCP Web", base_url: "http://127.0.0.1:8791/v1", wire_api: "responses", requires_openai_auth: false, supports_websockets: false, stream_idle_timeout_ms: 300000 });
  expect(result.launcherArgs).toContain('model_provider="isymcp_web"');
  expect(result.launcherArgs).not.toContain('openai_base_url="http://127.0.0.1:8791/v1"');
  expect(JSON.parse(readFileSync(result.catalogPath, "utf8")).models.map((m: any) => m.slug)).toEqual(["chatgpt-web/gpt-5.6-sol"]);
  for (const path of [result.profilePath, result.catalogPath, result.journalPath]) expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("Web profiles disable backend web_search while native search settings and launches stay intact", () => {
  const f = fixture();
  const nativeConfig = 'web_search = "live"\n' + f.config;
  writeFileSync(f.configPath, nativeConfig);
  const result = installWebModels({ ...f, apply: true });
  const parseArgs = (args: string[]) => Bun.TOML.parse(args.filter((_, index) => index % 2 === 1).join("\n")) as any;
  expect(parseArgs(buildIsolatedCodexArgs("http://127.0.0.1:9999/v1")).web_search).toBe("disabled");
  expect(parseArgs(result.launcherArgs).web_search).toBe("disabled");
  const profile = JSON.parse(readFileSync(result.profilePath, "utf8"));
  expect(parseArgs(profile.launcherArgs).web_search).toBe("disabled");
  expect(readFileSync(f.configPath, "utf8")).toBe(nativeConfig);
  expect(readFileSync(f.cachePath, "utf8")).toBe(f.cache);
  const nativeArgs = ["exec", "--model=gpt-6-luna", "--search", "search canary"];
  expect(buildCodexArgs(nativeArgs, "9999")).toEqual(nativeArgs);
});

test("dry run writes no isolated or global files; unsupported routes fail before writes", () => {
  const f = fixture();
  const result = installWebModels(f);
  expect(result.action).toBe("dry-run");
  expect(existsSync(f.profileDir)).toBe(false);
  expect(() => installWebModels({ ...f, apply: true, model: "gpt-6-luna" })).toThrow(/verified|verificada/i);
  expect(() => installWebModels({ ...f, apply: true, effort: "max" })).toThrow(/effort|esfuerzo/i);
  expect(existsSync(f.profileDir)).toBe(false);
});

test("restore disables a first isolated install while preserving native edits and catalog", () => {
  const f = fixture();
  const applied = installWebModels({ ...f, apply: true });
  const edited = f.config + '\n[projects.user]\ntrust_level = "trusted"\n';
  writeFileSync(f.configPath, edited);
  const restored = installWebModels({ ...f, restore: true });
  expect(restored.action).toBe("restore");
  expect(JSON.parse(readFileSync(applied.profilePath, "utf8")).enabled).toBe(false);
  expect(existsSync(applied.catalogPath)).toBe(true);
  expect(readFileSync(f.configPath, "utf8")).toBe(edited);
  expect(readFileSync(f.cachePath, "utf8")).toBe(f.cache);
});

test("restore returns a previous isolated profile and backups are private", () => {
  const f = fixture();
  const first = installWebModels({ ...f, apply: true });
  const original = readFileSync(first.profilePath, "utf8");
  const second = installWebModels({ ...f, apply: true, url: "http://127.0.0.1:9999/v1" });
  expect(second.backups?.profile).toBeTruthy();
  for (const path of [second.backups!.profile!, second.backups!.catalog!]) expect(statSync(path).mode & 0o777).toBe(0o600);
  installWebModels({ ...f, restore: true });
  expect(readFileSync(first.profilePath, "utf8")).toBe(original);
  expect(readFileSync(f.configPath, "utf8")).toBe(f.config);
});

test("restore fails closed when isolated artifacts were edited after apply", () => {
  const f = fixture();
  const result = installWebModels({ ...f, apply: true });
  const edited = readFileSync(result.profilePath, "utf8") + " \n";
  writeFileSync(result.profilePath, edited);
  expect(() => installWebModels({ ...f, restore: true })).toThrow(/changed|cambi/i);
  expect(readFileSync(result.profilePath, "utf8")).toBe(edited);
  expect(readFileSync(f.configPath, "utf8")).toBe(f.config);
});

test("legacy global restore never copies an entire backup over current Codex settings", () => {
  const f = fixture();
  const backupDir = join(f.root, "legacy");
  mkdirSync(backupDir);
  const backup = join(backupDir, "config.bak");
  writeFileSync(backup, 'model = "old"\n');
  writeFileSync(join(backupDir, "latest.json"), JSON.stringify({ configBackup: backup, configPath: f.configPath, cachePath: f.cachePath, cacheBackup: null }));
  expect(() => installWebModels({ ...f, backupDir, restore: true })).toThrow(/legacy|global|legado/i);
  expect(readFileSync(f.configPath, "utf8")).toBe(f.config);
  expect(readFileSync(f.cachePath, "utf8")).toBe(f.cache);
});

test("profile remains useful without native cache, without claiming catalog metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "isymcp-no-catalog-"));
  const result = installWebModels({ codexHome: join(root, "codex"), profileDir: join(root, "profile"), apply: true });
  expect(result.catalogReady).toBe(false);
  expect(result.launcherArgs.some(arg => arg.startsWith("model_catalog_json="))).toBe(false);
  expect(result.webRows).toEqual(["chatgpt-web/gpt-5.6-sol"]);
  expect(existsSync(result.configPath)).toBe(false);
  expect(existsSync(result.cachePath)).toBe(false);
});

test("provider argv parses as TOML and refers to a token environment name only", () => {
  const args = buildIsolatedCodexArgs("http://127.0.0.1:9999/v1", undefined, undefined, "/tmp/our catalog.json", "CODEX_WEB_HTTP_TOKEN");
  const overrides = args.filter((_, index) => index % 2 === 1).join("\n");
  const config = Bun.TOML.parse(overrides) as any;
  expect(config.model_provider).toBe("isymcp_web");
  expect(config.openai_base_url).toBeUndefined();
  expect(config.model_providers.isymcp_web.env_http_headers).toEqual({ "x-isymcp-token": "CODEX_WEB_HTTP_TOKEN" });
  expect(config.model_catalog_json).toBe("/tmp/our catalog.json");
  expect(() => buildIsolatedCodexArgs("http://127.0.0.1:9999/v1", "gpt-6-luna")).toThrow(/verificado/);
  expect(() => buildIsolatedCodexArgs("https://external.example/v1")).toThrow(/loopback/);
});

test("modified backups cannot replace the verified isolated profile", () => {
  const f = fixture();
  installWebModels({ ...f, apply: true });
  const result = installWebModels({ ...f, apply: true, url: "http://127.0.0.1:9999/v1" });
  const current = readFileSync(result.profilePath, "utf8");
  writeFileSync(result.backups!.profile!, '{"enabled":true,"foreign":true}\n');
  expect(() => installWebModels({ ...f, restore: true })).toThrow(/backup.*cambio/);
  expect(readFileSync(result.profilePath, "utf8")).toBe(current);
});

test("legacy executable and package command apply only to explicit isolated fixtures", () => {
  for (const argv of [["bun", "run", "scripts/install-codex.ts"], ["bun", "run", "install:codex"]]) {
    const f = fixture();
    const result = Bun.spawnSync([...argv, "--apply", "--codex-home", f.codexHome, "--profile-dir", f.profileDir], { cwd: join(import.meta.dir, ".."), env: { ...process.env } });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(f.configPath, "utf8")).toBe(f.config);
    expect(readFileSync(f.cachePath, "utf8")).toBe(f.cache);
    expect(JSON.parse(readFileSync(join(f.profileDir, "profile.json"), "utf8")).enabled).toBe(true);
  }
});
