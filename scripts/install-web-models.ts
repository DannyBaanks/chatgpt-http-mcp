#!/usr/bin/env bun
// Prepared profiles are private ISyMCP artifacts, activated only by an explicit
// launcher. Native Codex configuration, cache and other applications' journals
// are read-only. Restore checks ownership and never rolls back global settings.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseCapabilities } from "../src/config";
import { augmentCatalog, availableRoutes, CHATGPT_WEB_MODEL_PREFIX, VERIFIED_WEB_ROUTES, type CodexEffort } from "../src/web-models";
import { bridgeToken, TOKEN_HEADER } from "../src/local-guard";
import { getTopLevelTomlString } from "./install-codex";

const DEFAULT_URL = "http://127.0.0.1:8791/v1";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/**
 * Merge del catalogo: quita filas chatgpt-web previas (idempotente) y agrega
 * las actuales. Las filas nativas se dejan intactas.
 */
export function mergeWebRows(cache: unknown, caps: ReturnType<typeof parseCapabilities>): { models: unknown[]; added: string[]; kept: number } {
  const candidate = Array.isArray(cache) ? cache : cache && typeof cache === "object" ? (cache as { models?: unknown }).models : [];
  const before = Array.isArray(candidate) ? candidate : [];
  const kept = before.filter(
    (m) => !(m && typeof m === "object" && typeof (m as { slug?: unknown }).slug === "string" && (m as { slug: string }).slug.startsWith(CHATGPT_WEB_MODEL_PREFIX)),
  );
  // Without native metadata the launcher requests its own provider's catalog.
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

export const ISOLATED_PROVIDER_ID = "isymcp_web";

function validateBridgeUrl(url: string): string {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.replace(/\/$/, "") !== "/v1") {
    throw new Error("la URL del perfil debe ser un bridge loopback http(s) con ruta /v1, sin credenciales");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function isolatedProvider(url: string, tokenEnv?: string): Record<string, unknown> {
  if (tokenEnv && !/^[A-Z][A-Z0-9_]*$/.test(tokenEnv)) throw new Error("nombre de variable de token invalido");
  return {
    name: "ISyMCP Web", base_url: validateBridgeUrl(url), wire_api: "responses", requires_openai_auth: false,
    supports_websockets: false, stream_idle_timeout_ms: 300_000,
    ...(tokenEnv ? { env_http_headers: { [TOKEN_HEADER]: tokenEnv } } : {}),
  };
}

/** Config overrides belong to this process only; no secret values enter argv. */
export function buildIsolatedCodexArgs(
  url: string, model = "chatgpt-web/gpt-5.6-sol", effort = "high", catalogPath?: string,
  tokenEnv = bridgeToken() ? "CODEX_WEB_HTTP_TOKEN" : undefined,
): string[] {
  if (!VERIFIED_WEB_ROUTES[model]?.includes(effort as CodexEffort)) throw new Error("el perfil aislado requiere un modelo y esfuerzo Web verificado");
  const provider = isolatedProvider(url, tokenEnv);
  const fields = Object.entries(provider).map(([key, value]) => {
    const tomlValue = key === "env_http_headers"
      ? `{ ${Object.entries(value as Record<string, string>).map(([header, env]) => `${JSON.stringify(header)}=${JSON.stringify(env)}`).join(", ")} }`
      : JSON.stringify(value);
    return `${key}=${tomlValue}`;
  });
  return [
    "-c", `model_provider=${JSON.stringify(ISOLATED_PROVIDER_ID)}`,
    "-c", `model_providers.${ISOLATED_PROVIDER_ID}={ ${fields.join(", ")} }`,
    "-c", `model=${JSON.stringify(model)}`, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`,
    // Built-in web_search executes in an API backend, not the native Codex
    // executor. The Web text adapter accepts only client-executed tools.
    "-c", 'web_search="disabled"',
    ...(catalogPath ? ["-c", `model_catalog_json=${JSON.stringify(catalogPath)}`] : []),
  ];
}

function privateWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

interface ProfileJournal {
  version: "isymcp-isolated-profile/1";
  profilePath: string;
  catalogPath: string;
  installed: { profile: string; catalog: string };
  backups: { profile: string | null; catalog: string | null };
  previousHashes: { profile: string | null; catalog: string | null };
}

export interface Result {
  action: "dry-run" | "apply" | "restore";
  scope: "isolated";
  configPath: string;
  cachePath: string;
  url: string;
  previousUrl: string | null;
  previousModel: string | null;
  webRows: string[];
  nativeRowsKept: number;
  profilePath: string;
  catalogPath: string;
  journalPath: string;
  catalogReady: boolean;
  launcherArgs: string[];
  backups?: { profile: string | null; catalog: string | null };
}

export function installWebModels(options: {
  apply?: boolean;
  restore?: boolean;
  url?: string;
  caps?: string;
  backupDir?: string;
  model?: string;
  effort?: string;
  /** Explicit fixture paths; callers never need to replace HOME/CODEX_HOME. */
  codexHome?: string;
  profileDir?: string;
} = {}): Result {
  if (options.apply && options.restore) throw new Error("elige --apply o --restore, no ambos");
  const home = options.codexHome ?? defaultCodexHome();
  const configPath = resolve(join(home, "config.toml"));
  const cachePath = resolve(join(home, "models_cache.json"));
  const bridgeHome = process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http");
  const profileDir = resolve(options.profileDir ?? join(bridgeHome, "codex-profiles", "isymcp-web"));
  const profilePath = join(profileDir, "profile.json");
  const catalogPath = join(profileDir, "models.json");
  const backupDir = resolve(options.backupDir ?? join(profileDir, "backups"));
  const journalPath = join(backupDir, "latest.json");
  const url = validateBridgeUrl(options.url ?? DEFAULT_URL);
  const caps = parseCapabilities(options.caps);

  if (options.restore) {
    if (!existsSync(journalPath)) throw new Error(`no hay backup del perfil en ${backupDir} (--restore)`);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as ProfileJournal;
    if (journal.version !== "isymcp-isolated-profile/1") throw new Error("backup global legado: no se restaura encima de la configuracion actual de Codex");
    if (journal.profilePath !== profilePath || journal.catalogPath !== catalogPath) throw new Error("journal de otro perfil; no se restauraron archivos");
    if (!journal.installed || !journal.backups || !journal.previousHashes) throw new Error("journal del perfil incompleto");
    for (const [key, path] of [["profile", profilePath], ["catalog", catalogPath]] as const) {
      if (!existsSync(path) || digest(readFileSync(path, "utf8")) !== journal.installed[key]) throw new Error("el perfil cambio despues de aplicar; restaura manualmente sus cambios");
      const backup = journal.backups[key];
      if (backup && (!existsSync(backup) || dirname(resolve(backup)) !== backupDir)) throw new Error("backup del perfil invalido");
      if (backup && digest(readFileSync(backup, "utf8")) !== journal.previousHashes[key]) throw new Error("backup del perfil cambio despues de aplicar");
    }
    const restoredProfile = journal.backups.profile ? readFileSync(journal.backups.profile, "utf8") : json({ version: "isymcp-isolated-profile/1", enabled: false });
    const restoredCatalog = journal.backups.catalog ? readFileSync(journal.backups.catalog, "utf8") : null;
    privateWrite(profilePath, restoredProfile);
    // A first-install restore disables the profile and preserves its catalog.
    if (restoredCatalog !== null) privateWrite(catalogPath, restoredCatalog);
    return {
      action: "restore",
      scope: "isolated", configPath, cachePath, profilePath, catalogPath, journalPath,
      catalogReady: false, launcherArgs: [],
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
  const routes = availableRoutes(caps);
  const model = options.model ?? "chatgpt-web/gpt-5.6-sol";
  const route = routes.find(route => route.slug === model);
  if (!route) throw new Error(`modelo Web sin ruta verificada: ${model}`);
  const effort = options.effort ?? route.defaultEffort;
  if (!route.supportedEfforts.includes(effort as CodexEffort)) throw new Error(`esfuerzo/effort Web no verificado: ${effort}`);
  const webModels = merged.models.filter(model => model && typeof model === "object" && String((model as { slug?: string }).slug).startsWith(CHATGPT_WEB_MODEL_PREFIX));
  const catalogReady = webModels.length > 0;
  const tokenEnv = bridgeToken() ? "CODEX_WEB_HTTP_TOKEN" : undefined;
  const launcherArgs = buildIsolatedCodexArgs(url, model, effort, catalogReady ? catalogPath : undefined, tokenEnv);
  const previousUrl = getTopLevelTomlString(configText, "openai_base_url");
  const previousModel = getTopLevelTomlString(configText, "model");

  if (!options.apply) {
    return {
      action: "dry-run",
      scope: "isolated", profilePath, catalogPath, journalPath, catalogReady, launcherArgs,
      configPath,
      cachePath,
      url,
      previousUrl,
      previousModel,
      webRows: merged.added,
      nativeRowsKept: merged.kept,
    };
  }

  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const backups = { profile: existsSync(profilePath) ? join(backupDir, `profile.${stamp}.json`) : null, catalog: existsSync(catalogPath) ? join(backupDir, `models.${stamp}.json`) : null };
  const previousHashes: ProfileJournal["previousHashes"] = { profile: null, catalog: null };
  for (const [key, path] of [["profile", profilePath], ["catalog", catalogPath]] as const) {
    if (backups[key]) {
      const previous = readFileSync(path, "utf8");
      privateWrite(backups[key]!, previous);
      previousHashes[key] = digest(previous);
    }
  }
  const profileText = json({ version: "isymcp-isolated-profile/1", enabled: true, model, effort, providerId: ISOLATED_PROVIDER_ID,
    provider: isolatedProvider(url, tokenEnv), catalogPath: catalogReady ? catalogPath : null, launcherArgs });
  const catalogText = json({ models: webModels });
  privateWrite(catalogPath, catalogText);
  privateWrite(profilePath, profileText);
  const journal: ProfileJournal = { version: "isymcp-isolated-profile/1", profilePath, catalogPath,
    installed: { profile: digest(profileText), catalog: digest(catalogText) }, backups, previousHashes };
  privateWrite(journalPath, json(journal));

  return {
    action: "apply",
    scope: "isolated", profilePath, catalogPath, journalPath, catalogReady, launcherArgs,
    configPath,
    cachePath,
    url,
    previousUrl,
    previousModel,
    webRows: merged.added,
    nativeRowsKept: merged.kept,
    backups,
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
    codexHome: argValue("--codex-home"),
    profileDir: argValue("--profile-dir"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.action === "dry-run") {
    console.log("\n(dry-run: --apply prepara solo el perfil aislado; --restore revierte ese perfil)");
  }
}
