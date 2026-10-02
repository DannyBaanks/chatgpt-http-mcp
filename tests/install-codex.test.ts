// install-codex.test.ts — M2: edicion TOML con backup y restore, sin tocar ~/.codex.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getTopLevelTomlString,
  install,
  setTopLevelTomlString,
} from "../scripts/install-codex";

test("setTopLevelTomlString reemplaza o inserta antes de las tablas", () => {
  const withKey = `model = "gpt-5.6"\nopenai_base_url = "https://old.example/v1"\n\n[model_providers]\nfoo = 1\n`;
  const replaced = setTopLevelTomlString(withKey, "openai_base_url", "http://127.0.0.1:8791/v1");
  expect(getTopLevelTomlString(replaced, "openai_base_url")).toBe("http://127.0.0.1:8791/v1");
  expect(replaced).toContain("[model_providers]");
  expect(replaced.indexOf("openai_base_url")).toBeLessThan(replaced.indexOf("[model_providers]"));

  const withoutKey = `model = "gpt-5.6"\n\n[model_providers]\nfoo = 1\n`;
  const inserted = setTopLevelTomlString(withoutKey, "openai_base_url", "http://127.0.0.1:8791/v1");
  expect(inserted).toContain('openai_base_url = "http://127.0.0.1:8791/v1"');
  expect(inserted.indexOf("openai_base_url")).toBeLessThan(inserted.indexOf("[model_providers]"));
});

test("dry-run no escribe; apply hace backup; restore vuelve al original", () => {
  const dir = mkdtempSync(join(tmpdir(), "cwh-install-"));
  const configPath = join(dir, "config.toml");
  const backupDir = join(dir, "backups");
  const original = `model = "gpt-5.6"\nopenai_base_url = "https://old.example/v1"\n\n[model_providers]\nfoo = 1\n`;
  writeFileSync(configPath, original);

  const dry = install({ configPath, backupDir, url: "http://127.0.0.1:9999/v1" });
  expect(dry.action).toBe("dry-run");
  expect(dry.previous).toBe("https://old.example/v1");
  expect(readFileSync(configPath, "utf8")).toBe(original);

  const applied = install({ configPath, backupDir, apply: true, url: "http://127.0.0.1:9999/v1" });
  expect(applied.action).toBe("apply");
  expect(applied.backupPath && existsSync(applied.backupPath)).toBe(true);
  const after = readFileSync(configPath, "utf8");
  expect(after).toContain('openai_base_url = "http://127.0.0.1:9999/v1"');
  expect(after).toContain("[model_providers]");
  expect(after).not.toContain("old.example");

  const restored = install({ configPath, backupDir, restore: true });
  expect(restored.action).toBe("restore");
  expect(readFileSync(configPath, "utf8")).toBe(original);
});
