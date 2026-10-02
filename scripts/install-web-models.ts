#!/usr/bin/env bun
// install-web-models.ts — "Install into Codex" propio: agrega las filas
// chatgpt-web al catalogo de Codex y apunta openai_base_url a este server.
//
// Mecanismo (el mismo que usa el launcher de referencia, verificado en disco):
//   1. ~/.codex/models_cache.json  -> MERGE de las filas chatgpt-web (las
//      nativas se conservan: el selector no pierde gpt-5.x).
//   2. ~/.codex/config.toml         -> openai_base_url = http://127.0.0.1:8791/v1
//   3. opcional                    -> model / model_reasoning_effort.
//
// Seguro por defecto: sin --apply solo muestra el cambio. Con --apply backs up
// config.toml + models_cache.json y escribe un journal para --restore.
// NUNCA toca auth.json ni las claves nativas del catalogo.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseCapabilities } from "../src/config";
import { augmentCatalog, availableRoutes, CHATGPT_WEB_MODEL_PREFIX } from "../src/web-models";
import { getTopLevelTomlString, setTopLevelTomlString } from "./install-codex";

const DEFAULT_URL = "http://127.0.0.1:8791/v1";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/**
 * Merge del catalogo: quita filas chatgpt-web previas (idempotente) y agrega
 * las actuales. Las filas nativas se dejan intactas.
 */
export function mergeWebRows(cache: unknown, caps: ReturnType<typeof parseCapabilities>): { models: unknown[]; added: string[]; kept: number } {
  const before = (cache && typeof cache === "object" ? (cache as { models?: unknown }).models : Array.isArray(cache) ? cache : []) as unknown[];
  const kept = before.filter(
    (m) => !(m && typeof m === "object" && typeof (m as { slug?: unknown }).slug === "string" && (m as { slug: string }).slug.startsWith(CHATGPT_WEB_MODEL_PREFIX)),
  );
  // Sin cache (la referencia lo borra) no hay template nativo. El install igual
  // apunta la ruta: Codex pide /v1/models al bridge y ahi se clonan las filas.
  try {
    const augmented = augmentCatalog({ models: kept }, caps) as { models: Array<Record<string, unknown>> };
    const added = augmented.models
      .map((m) => m.slug)
      .filter((s): s is string => typeof s === "string" && s.startsWith(CHATGPT_WEB_MODEL_PREFIX));
    return { models: augmented.models, added, kept: kept.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("template")) throw error;
    return {
      models: kept,
      added: availableRoutes(caps).map((route) => route.slug),
      kept: kept.length,
    };
  }
}

/**
 * El launcher de referencia deja un journal activo. Si openai_base_url del
 * journal no coincide con el config, el proximo arranque de Codex restaura
 * el puerto viejo (medido: 17841 piso a 8791 a los 30s de aplicar).
 * Retargetea solo esa URL. No toca el resto del journal.
 */
function retargetReferenceJournal(url: string): string | null {
  const journalPath = join(homedir(), ".codex-chatgpt-web", "codex", "integration-journal.json");
  if (!existsSync(journalPath)) return null;
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    installed?: { openai_base_url?: string };
  };
  if (!journal.installed || journal.installed.openai_base_url === url) return journalPath;
  const backup = journalPath + ".pre-codex-web-http";
  if (!existsSync(backup)) copyFileSync(journalPath, backup);
  journal.installed.openai_base_url = url;
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n");
  return journalPath;
}

export interface Result {
  action: "dry-run" | "apply" | "restore";
  configPath: string;
  cachePath: string;
  url: string;
  previousUrl: string | null;
  previousModel: string | null;
  webRows: string[];
  nativeRowsKept: number;
  backups?: { config: string; cache: string | null };
}

export function installWebModels(options: {
  apply?: boolean;
  restore?: boolean;
  url?: string;
  caps?: string;
  backupDir?: string;
  model?: string;
  effort?: string;
} = {}): Result {
  const home = codexHome();
  const configPath = resolve(join(home, "config.toml"));
  const cachePath = resolve(join(home, "models_cache.json"));
  const backupDir = resolve(options.backupDir ?? join(import.meta.dir, "..", "backups", "web-models"));
  const url = options.url ?? DEFAULT_URL;
  const caps = parseCapabilities(options.caps);

  if (options.restore) {
    const latest = join(backupDir, "latest.json");
    if (!existsSync(latest)) throw new Error(`no hay backup en ${backupDir} (--restore)`);
    const journal = JSON.parse(readFileSync(latest, "utf8")) as { configBackup: string; cacheBackup: string | null; configPath: string; cachePath: string };
    copyFileSync(journal.configBackup, journal.configPath);
    if (journal.cacheBackup && existsSync(journal.cacheBackup)) copyFileSync(journal.cacheBackup, journal.cachePath);
    else writeFileSync(journal.cachePath, JSON.stringify({ models: [] }, null, 2));
    return {
      action: "restore",
      configPath: journal.configPath,
      cachePath: journal.cachePath,
      url,
      previousUrl: null,
      previousModel: null,
      webRows: [],
      nativeRowsKept: 0,
    };
  }

  const configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const cacheRaw = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : { models: [] };
  const merged = mergeWebRows(cacheRaw, caps);
  const previousUrl = getTopLevelTomlString(configText, "openai_base_url");
  const previousModel = getTopLevelTomlString(configText, "model");

  if (!options.apply) {
    return {
      action: "dry-run",
      configPath,
      cachePath,
      url,
      previousUrl,
      previousModel,
      webRows: merged.added,
      nativeRowsKept: merged.kept,
    };
  }

  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const configBackup = join(backupDir, `config.toml.${stamp}`);
  const cacheBackup = existsSync(cachePath) ? join(backupDir, `models_cache.json.${stamp}`) : null;
  writeFileSync(configBackup, configText);
  if (cacheBackup) writeFileSync(cacheBackup, JSON.stringify(cacheRaw, null, 2));

  let next = setTopLevelTomlString(configText, "openai_base_url", url);
  if (options.model) next = setTopLevelTomlString(next, "model", options.model);
  if (options.effort) next = setTopLevelTomlString(next, "model_reasoning_effort", options.effort);
  writeFileSync(configPath, next);
  // La referencia NO deja el cache escrito: lo borra para que Codex, al
  // reabrir, pida GET /v1/models al bridge vivo y reciba las filas web.
  // Un cache pre-escrito lo ignora el app-server si la ruta no es la suya.
  if (existsSync(cachePath)) rmSync(cachePath);
  retargetReferenceJournal(url);
  writeFileSync(join(backupDir, "latest.json"), JSON.stringify({ configBackup, cacheBackup, configPath, cachePath }, null, 2));

  return {
    action: "apply",
    configPath,
    cachePath,
    url,
    previousUrl,
    previousModel,
    webRows: merged.added,
    nativeRowsKept: merged.kept,
    backups: { config: configBackup, cache: cacheBackup },
  };
}

if (import.meta.main) {
  const result = installWebModels({
    apply: process.argv.includes("--apply"),
    restore: process.argv.includes("--restore"),
    url: argValue("--url"),
    caps: argValue("--caps"),
    model: argValue("--model"),
    effort: argValue("--effort"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.action === "dry-run") {
    console.log("\n(dry-run: usa --apply para escribir. Con backup + --restore para revertir)");
  }
}