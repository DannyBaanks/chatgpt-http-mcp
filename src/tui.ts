// tui.ts — detectar TUIs instaladas e inyectar provider+MCP de este bridge.
//
// Soporta todas las TUIs principales (Antigravity/Gemini, Claude Code/Desktop,
// Cursor, OpenCode/OpenISy, Codex CLI, Hermes, OpenClaw, Qwen, etc.).
//
// Reglas heredadas de install-codex.ts: dry-run por defecto, apply con backup
// + journal, restore desde el journal. Nunca se tocan secretos ni claves ajenas.
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { availableRoutes, resolveLimits } from "./web-models";
import { parseCapabilities as parseCaps } from "./config";

export type TuiFormat = "mcpServers" | "opencode" | "codex";

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
export function detectTuis(home: string = HOME): TuiInfo[] {
  const table: Array<Omit<TuiInfo, "present" | "installable">> = [
    {
      id: "opencode",
      label: "opencode/OpenISy",
      configDir: join(home, ".config", "opencode"),
      configPath: join(home, ".config", "opencode", "opencode.json"),
      bin: which("opencode"),
      format: "opencode",
    },
    {
      id: "gemini",
      label: "Antigravity CLI / Gemini",
      configDir: join(home, ".gemini", "config"),
      configPath: join(home, ".gemini", "config", "mcp_config.json"),
      bin: which("agy"),
      format: "mcpServers",
    },
    {
      id: "claude",
      label: "Claude Code / Claude Desktop",
      configDir: join(home, ".claude"),
      configPath: join(home, ".claude", "claude_desktop_config.json"),
      bin: which("claude"),
      format: "mcpServers",
    },
    {
      id: "cursor",
      label: "Cursor",
      configDir: join(home, ".cursor"),
      configPath: join(home, ".cursor", "mcp.json"),
      bin: which("cursor"),
      format: "mcpServers",
    },
    {
      id: "codex",
      label: "Codex CLI",
      configDir: join(home, ".codex"),
      configPath: join(home, ".codex", "config.toml"),
      bin: which("codex"),
      format: "codex",
    },
    { id: "hermes", label: "Hermes", configDir: join(home, ".hermes"), configPath: join(home, ".hermes", "config.json"), format: "mcpServers" },
    { id: "openclaw", label: "OpenClaw", configDir: join(home, ".openclaw"), configPath: join(home, ".openclaw", "config.json"), format: "mcpServers" },
    { id: "qwen", label: "Qwen", configDir: join(home, ".qwen"), configPath: join(home, ".qwen", "config.json"), format: "mcpServers" },
    { id: "copilot", label: "Copilot", configDir: join(home, ".copilot"), configPath: join(home, ".copilot", "config.json"), format: "mcpServers" },
    { id: "pi", label: "Pi", configDir: join(home, ".pi"), configPath: join(home, ".pi", "config.json"), format: "mcpServers" },
    { id: "fx", label: "fx", configDir: join(home, ".fx"), configPath: join(home, ".fx", "config.json"), format: "mcpServers" },
  ];

  return table.map((row) => ({
    ...row,
    present: existsSync(row.configDir) || existsSync(row.configPath) || Boolean(row.bin && existsSync(row.bin)),
    installable: true,
  }));
}

export const OPENCODE_PROVIDER_ID = "isyco-web";
export const OPENCODE_MCP_ID = "isyco-web-http";

/** Elimina comentarios simples y de bloque en archivos JSONC preservando strings literales. */
export function stripJsonComments(str: string): string {
  return str.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => (g ? "" : m));
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
  mcp: Record<string, unknown>;
}

/** Entrada provider+MCP apuntando al loopback de este bridge. */
export function buildOpencodePatch(baseUrl: string, mcpMain: string, capsRaw?: string): OpencodePatch {
  return {
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "ISyCo Web (ChatGPT)",
        options: { baseURL: `${baseUrl.replace(/\/+$/, "")}/v1`, apiKey: "local-bridge" },
        models: buildOpencodeModels(capsRaw),
      },
    },
    mcp: {
      [OPENCODE_MCP_ID]: {
        type: "local",
        command: ["bun", mcpMain, "--contract", "native"],
        enabled: true,
        environment: {},
      },
    },
  };
}

export interface TuiInstallOptions {
  configPath: string;
  backupsDir: string;
  baseUrl: string;
  mcpMain: string;
  capsRaw?: string;
  dryRun: boolean;
  restore?: boolean;
}

export interface TuiInstallResult {
  action: "dry-run" | "apply" | "restore" | "noop";
  configPath: string;
  backupPath?: string;
  models: number;
}

/** Aplica (con backup+journal) o restaura el parche opencode. */
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
  const patch = buildOpencodePatch(options.baseUrl, options.mcpMain, options.capsRaw);
  const next = {
    ...current,
    provider: { ...(current.provider ?? {}), ...patch.provider },
    mcp: { ...(current.mcp ?? {}), ...patch.mcp },
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

export interface StandardMcpInstallOptions {
  configPath: string;
  backupsDir: string;
  mcpMain: string;
  dryRun: boolean;
  restore?: boolean;
  tuiId: string;
  serverKey?: string;
}

/** Inyecta ISyMCP en el formato estándar mcpServers (usado por Gemini/AGY, Claude, Cursor, etc.). */
export function installIntoStandardMcpTui(options: StandardMcpInstallOptions): TuiInstallResult {
  const configPath = resolve(options.configPath);
  const backupsDir = join(options.backupsDir, options.tuiId);
  const serverKey = options.serverKey ?? "isymcp";

  if (options.restore) {
    const latest = join(backupsDir, "latest.json");
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
    } catch (err) {
      throw new Error(`Error al leer archivo JSON en ${configPath}: ${(err as Error).message}`);
    }
  }

  const mcpServers = (current.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers))
    ? current.mcpServers
    : {};

  const next = {
    ...current,
    mcpServers: {
      ...mcpServers,
      [serverKey]: {
        command: "bun",
        args: ["run", options.mcpMain, "--contract", "native"],
        disabled: false,
      },
    },
  };

  if (options.dryRun) {
    return { action: "dry-run", configPath, models: 1 };
  }

  mkdirSync(backupsDir, { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupsDir, `${options.tuiId}-${stamp}.json`);
  if (existsSync(configPath)) copyFileSync(configPath, backupPath);
  else writeFileSync(backupPath, "{}\n");

  writeFileSync(join(backupsDir, "latest.json"), JSON.stringify({ backupPath, configPath }));
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return { action: "apply", configPath, backupPath, models: 1 };
}

export interface UniversalTuiInstallOptions {
  tuiId: string;
  home?: string;
  configPath?: string;
  backupsDir: string;
  baseUrl?: string;
  mcpMain: string;
  capsRaw?: string;
  dryRun: boolean;
  restore?: boolean;
}

/** Despachador universal para instalar ISyMCP en cualquier TUI detectada. */
export function installIntoTui(options: UniversalTuiInstallOptions): TuiInstallResult {
  const home = options.home || HOME;
  const tuis = detectTuis(home);
  const target = tuis.find((t) => t.id === options.tuiId);
  if (!target) {
    throw new Error(`TUI desconocida: '${options.tuiId}'. Disponibles: ${tuis.map((t) => t.id).join(", ")}`);
  }

  const effectiveConfigPath = options.configPath || target.configPath;

  if (target.format === "opencode") {
    return installIntoOpencode({
      configPath: effectiveConfigPath,
      backupsDir: join(options.backupsDir, "opencode"),
      baseUrl: options.baseUrl || "http://127.0.0.1:8791",
      mcpMain: options.mcpMain,
      capsRaw: options.capsRaw,
      dryRun: options.dryRun,
      restore: options.restore,
    });
  }

  if (target.format === "codex") {
    // Codex CLI usa perfiles aislados via 'isymcp models apply'
    return {
      action: options.dryRun ? "dry-run" : "noop",
      configPath: effectiveConfigPath,
      models: 0,
    };
  }

  return installIntoStandardMcpTui({
    configPath: effectiveConfigPath,
    backupsDir: options.backupsDir,
    mcpMain: options.mcpMain,
    dryRun: options.dryRun,
    restore: options.restore,
    tuiId: target.id,
  });
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
