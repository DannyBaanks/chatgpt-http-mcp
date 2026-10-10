import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as selection from "../src/responses/selection";
import { parseCapabilities } from "../src/config";
import { augmentCatalog, availableRoutes, openAiWebModelList, resolveLimits } from "../src/web-models";
import { buildIsolatedCodexArgs, installWebModels } from "../scripts/install-web-models";

const gpt6 = "chatgpt-web/gpt-6";
const seen = (model = "GPT-6", effort = "High", position = 3, steps = 3) =>
  ({ model, effort, pill: effort, effortPosition: position, effortSteps: steps });
const native = { slug: "gpt-6-luna", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] };

test("the explicit GPT-6 alias accepts only the observed GPT-6 high 3/3 state", () => {
  expect(() => selection.assertWebSelection(gpt6, "high", seen())).not.toThrow();
  expect(() => selection.assertWebSelection(gpt6, "high", seen("GPT-6", "Alta"))).not.toThrow();
  for (const state of [seen("GPT-5.6 Sol"), seen("GPT-6.1 Sol"), seen("GPT-6", "Medium", 2), seen("GPT-6", "High", 3, 4)])
    expect(() => selection.assertWebSelection(gpt6, "high", state)).toThrow("web_model_state_mismatch");
  for (const effort of ["medium", "max", "xhigh", "invented"])
    expect(() => selection.assertWebSelection(gpt6, effort)).toThrow("web_model_selection_unsupported");
});

test("model labels preserve distinct aliases and reject unknown or native IDs", () => {
  const label = selection.webModelLabel;
  expect(typeof label).toBe("function");
  expect(label(gpt6)).toBe("GPT-6");
  expect(label("chatgpt-web/gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  for (const model of ["gpt-6", "gpt-6.1-sol", "chatgpt-web/gpt-6.1-sol", "chatgpt-web/unknown"])
    expect(() => label(model)).toThrow("web_model_selection_unsupported");
});

test("GPT-6 advertising requires its own explicit capability independent of Sol", () => {
  expect(availableRoutes(parseCapabilities(undefined)).map(r => r.slug)).toEqual(["chatgpt-web/gpt-5.6-sol"]);
  expect(availableRoutes(parseCapabilities("sol,pro,extrahigh")).some(r => r.slug === gpt6)).toBe(false);
  expect(availableRoutes({ solAvailable: true, proAvailable: false, gpt6Available: false }).some(r => r.slug === gpt6)).toBe(false);
  expect(availableRoutes(parseCapabilities("gpt6")).map(r => r.slug)).toEqual([gpt6]);
  expect(availableRoutes(parseCapabilities("sol,gpt6")).map(r => r.slug)).toEqual(["chatgpt-web/gpt-5.6-sol", gpt6]);
  const route = availableRoutes(parseCapabilities("gpt6"))[0]!;
  expect(route.backendModel).toBe("gpt-6");
  expect(route.supportedEfforts).toEqual(["high"]);
  expect((openAiWebModelList(parseCapabilities("gpt6")) as any).data.map((m: any) => m.id)).toEqual([gpt6]);
});

test("GPT-6 capability parses an exact flag without granting old Sol or native 6.1 aliases", () => {
  expect(parseCapabilities(" GPT6 ").gpt6Available).toBe(true);
  expect(parseCapabilities("gpt6").solAvailable).toBe(false);
  for (const flags of [undefined, "sol", "gpt-6", "gpt6.1", "gpt-6.1-sol"])
    expect(parseCapabilities(flags).gpt6Available).toBe(false);
});

test("GPT-6 rows retain native bytes and label an adapter budget that Pro/bigger cannot inflate", () => {
  const catalog = { models: [native] };
  const before = JSON.stringify(catalog);
  const caps = parseCapabilities("gpt6,pro,bigger");
  const models = (augmentCatalog(catalog, caps) as any).models;
  expect(JSON.stringify(catalog)).toBe(before);
  expect(models[0]).toEqual(native);
  const row = models.find((m: any) => m.slug === gpt6);
  expect(row).toBeDefined();
  expect(row.isymcp_context_limit_source).toBe("adapter_budget");
  expect(row.context_window).toBeGreaterThan(0);
  expect(row.context_window).toBeLessThanOrEqual(32_000);
  expect(row.auto_compact_token_limit).toBeLessThan(row.context_window);
  expect(row.context_window).toBe(resolveLimits("gpt-6", "high", parseCapabilities("gpt6")).contextWindow);
  expect(row.supported_reasoning_levels.map((l: any) => l.effort)).toEqual(["high"]);
  expect(() => resolveLimits("gpt-6", "medium", caps)).toThrow();
});

test("isolated GPT-6 preparation is explicit and preserves native config/cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "isymcp-gpt6-profile-"));
  const codexHome = join(dir, "codex");
  const profileDir = join(dir, "profile");
  mkdirSync(codexHome);
  const config = 'model = "gpt-6-luna"\n';
  const cache = JSON.stringify({ models: [native] });
  writeFileSync(join(codexHome, "config.toml"), config);
  writeFileSync(join(codexHome, "models_cache.json"), cache);
  expect(() => installWebModels({ codexHome, profileDir, model: gpt6, apply: true })).toThrow();
  expect(existsSync(profileDir)).toBe(false);
  const applied = installWebModels({ codexHome, profileDir, model: gpt6, caps: "gpt6", effort: "high", apply: true });
  expect(JSON.parse(readFileSync(applied.profilePath, "utf8")).model).toBe(gpt6);
  expect(applied.launcherArgs).toContain('model="chatgpt-web/gpt-6"');
  expect(applied.launcherArgs).toContain('model_provider="isymcp_web"');
  expect(buildIsolatedCodexArgs("http://127.0.0.1:8791/v1", gpt6)).toContain('model="chatgpt-web/gpt-6"');
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(config);
  expect(readFileSync(join(codexHome, "models_cache.json"), "utf8")).toBe(cache);
  const defaults = installWebModels({ codexHome, profileDir: join(dir, "default") });
  expect(defaults.launcherArgs).toContain('model="chatgpt-web/gpt-5.6-sol"');
});
