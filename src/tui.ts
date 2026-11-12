// tui.ts — detectar TUIs instaladas e inyectar provider+MCP de este bridge.
//
// Soporta todas las TUIs principales (Antigravity/Gemini, Claude Code/Desktop,
// Cursor, OpenCode/OpenISy, Codex CLI, Hermes, OpenClaw, Qwen, etc.).
//
// Reglas heredadas de install-codex.ts: dry-run por defecto, apply con backup
// + journal, restore desde el journal. Nunca se tocan secretos ni claves ajenas.
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { availableRoutes, resolveLimits } from "./web-models";
import { parseCapabilities as parseCaps } from "./config";
import { AGENTS, type TuiFormat } from "./agents/catalog";

/**
 * Formato de cada TUI en `tui install` (declarado en src/agents/catalog.ts):
 * "harness" = la TUI trae su propio `mcp add` (o tiene config verificada en src/harness.ts):
 * se instala con `isymcp harness install <id> --server gateway`, no adivinando un JSON.
 */
export type { TuiFormat };

export interface TuiInfo {
  id: string;
  label: string;
  configDir: string;
  configPath: string;
  bin?: string;
  present: boolean;
  installable: boolean;
  format: TuiFormat;
}

const HOME = homedir();

function which(bin: string): string | undefined {
  return Bun.which(bin, { PATH: process.env.PATH ?? "" }) ?? undefined;
}

/** Inventario: config dir, config file y/o binario en PATH. */
/** Inventario para `tui install`: vista de src/agents/catalog.ts (agentes con tuiFormat). */
export function detectTuis(home: string = HOME): TuiInfo[] {
  return AGENTS.filter((a) => a.tuiFormat).map((a) => {
    // env vacío: el inventario con un home sintético no debe leer variables del host (OPENISY_CONFIG_DIR...).
    const configDir = a.config ? a.config.dir(home, {}) : join(home, `.${a.id}`);
    const file = a.config?.file?.(home, {});
    const bin = a.executables.map((e) => which(e)).find(Boolean);
    return {
      id: a.id,
      label: a.label,
      configDir,
      configPath: file ?? `(${a.executables[0]} mcp add)`,
      ...(bin ? { bin } : {}),
      format: a.tuiFormat!,
      present: existsSync(configDir) || Boolean(file && existsSync(file)) || Boolean(bin && existsSync(bin)),
      installable: true,
    };
  });
}

export const OPENCODE_PROVIDER_ID = "isyco-web";

/** Elimina comentarios simples y de bloque en archivos JSONC preservando strings literales con cualquier escape. */
export function stripJsonComments(str: string): string {
  return str.replace(
    /("(?:[^"\\]|\\.)*")|(\/\*[\s\S]*?\*\/|\/\/.*)/g,
    (_match, jsonString) => {
      if (jsonString !== undefined) return jsonString;
      return "";
    }
  );
}

/** Filas Web como models de opencode, con su context window real. */
export function buildOpencodeModels(capsRaw?: string): Record<string, { name: string; limit: { context: number; output: number } }> {
  const caps = parseCaps(capsRaw ?? process.env.CODEX_WEB_HTTP_CAPS);
  const models: Record<string, { name: string; limit: { context: number; output: number } }> = {};
  for (const route of availableRoutes(caps)) {
    const context = resolveLimits(route.backendModel, route.defaultEffort, caps).contextWindow;
    models[route.slug] = { name: route.displayName, limit: { context, output: context } };
  }
  return models;
}

export interface OpencodePatch {
  provider: Record<string, unknown>;
}

/**
 * Provider de modelos Web apuntando al loopback de este bridge. El MCP NO va aquí: lo instala
 * src/harness.ts (`--server gateway`), el único que escribe MCP en las configs.
 */
export function buildOpencodePatch(baseUrl: string, capsRaw?: string): OpencodePatch {
  return {
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "ISyCo Web (ChatGPT)",
        options: { baseURL: `${baseUrl.replace(/\/+$/, "")}/v1`, apiKey: "local-bridge" },
        models: buildOpencodeModels(capsRaw),
      },
    },
  };
}

export interface TuiInstallOptions {
  configPath: string;
  backupsDir: string;
  baseUrl: string;
  capsRaw?: string;
  dryRun: boolean;
  restore?: boolean;
}

export interface TuiInstallResult {
  action: "dry-run" | "apply" | "restore" | "noop";
  configPath: string;
  backupPath?: string;
  models: number;
  /** true: el MCP de esta TUI se instala con `isymcp harness install <id> --server gateway`. */
  harness?: boolean;
}

/** Aplica (con backup+journal) o restaura el provider de modelos Web de opencode/openisy. */
export function installIntoOpencode(options: TuiInstallOptions): TuiInstallResult {
  const configPath = resolve(options.configPath);
  if (options.restore) {
    const latest = join(options.backupsDir, "tui-latest.json");
    if (!existsSync(latest)) throw new Error(`no hay backup en ${latest}`);
    const journal = JSON.parse(readFileSync(latest, "utf8")) as { backupPath: string; configPath: string };
    copyFileSync(journal.backupPath, journal.configPath);
    return { action: "restore", configPath: journal.configPath, backupPath: journal.backupPath, models: 0 };
  }
  let current: Record<string, any> = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf8");
      const clean = stripJsonComments(raw).trim();
      const parsed = clean ? JSON.parse(clean) : {};
      current = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
    } catch (err: any) {
      throw new Error(`Error al leer archivo JSON en ${configPath}: ${err.message}`);
    }
  }
  const patch = buildOpencodePatch(options.baseUrl, options.capsRaw);
  const next = {
    ...current,
    provider: { ...(current.provider ?? {}), ...patch.provider },
  };
  const models = Object.keys((patch.provider[OPENCODE_PROVIDER_ID] as { models: Record<string, unknown> }).models).length;
  if (options.dryRun) {
    return { action: "dry-run", configPath, models };
  }
  mkdirSync(options.backupsDir, { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(options.backupsDir, `opencode-${stamp}.json`);
  if (existsSync(configPath)) copyFileSync(configPath, backupPath);
  else writeFileSync(backupPath, "{}\n");
  writeFileSync(join(options.backupsDir, "tui-latest.json"), JSON.stringify({ backupPath, configPath }));
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return { action: "apply", configPath, backupPath, models };
}

export interface UniversalTuiInstallOptions {
  tuiId: string;
  home?: string;
  configPath?: string;
  backupsDir: string;
  baseUrl?: string;
  capsRaw?: string;
  dryRun: boolean;
  restore?: boolean;
}

/** alias -> id, derivado del catálogo único. */
export const TUI_ALIASES: Record<string, string> = Object.fromEntries(
  AGENTS.filter((a) => a.tuiFormat).flatMap((a) => a.aliases.map((alias) => [alias, a.id])),
);

/** Despachador universal para instalar ISyMCP en cualquier TUI detectada. */
export function installIntoTui(options: UniversalTuiInstallOptions): TuiInstallResult {
  const home = options.home || HOME;
  const tuis = detectTuis(home);
  const normalizedId = TUI_ALIASES[options.tuiId.toLowerCase()] ?? options.tuiId.toLowerCase();
  const target = tuis.find((t) => t.id === normalizedId);
  if (!target) {
    throw new Error(`TUI desconocida: '${options.tuiId}'. Disponibles: ${tuis.map((t) => t.id).join(", ")}`);
  }

  const effectiveConfigPath = options.configPath || target.configPath;

  if (target.format === "opencode") {
    // Provider de modelos Web aquí; el MCP lo instala harness (harness: true).
    const res = installIntoOpencode({
      configPath: effectiveConfigPath,
      // Un journal por TUI: opencode y openisy no comparten "latest" (un restore no cruza archivos).
      backupsDir: join(options.backupsDir, target.id),
      baseUrl: options.baseUrl || "http://127.0.0.1:8791",
      capsRaw: options.capsRaw,
      dryRun: options.dryRun,
      restore: options.restore,
    });
    return { ...res, harness: true };
  }

  // El MCP se instala solo por src/harness.ts (`--server gateway`), con verificación de la propia TUI.
  return {
    action: options.dryRun ? "dry-run" : "noop",
    configPath: effectiveConfigPath,
    models: 0,
    harness: true,
  };
}

/** Instala o restaura ISyMCP en todas las TUIs disponibles. */
export function installIntoAllTuis(options: Omit<UniversalTuiInstallOptions, "tuiId"> & { onlyPresent?: boolean }): Array<{ tui: TuiInfo; result?: TuiInstallResult; error?: string }> {
  const home = options.home || HOME;
  const tuis = detectTuis(home);
  const targets = options.onlyPresent ? tuis.filter((t) => t.present) : tuis;

  return targets.map((tui) => {
    try {
      const result = installIntoTui({ ...options, tuiId: tui.id });
      return { tui, result };
    } catch (err: any) {
      return { tui, error: err.message };
    }
  });
}
