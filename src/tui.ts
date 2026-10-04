// tui.ts — detectar TUIs instaladas e inyectar provider+MCP de este bridge.
//
// Alcance: SOLO opencode/OpenISy esta implementado (provider openai-compatible
// + MCP local). Las demas TUIs (.codex, .hermes, .openclaw, .qwen, .copilot,
// .pi, .fx, ...) se DETECTAN para inventario, pero su install queda
// NOT_DEMONSTRATED: cada una tiene su propio formato de config.
//
// Reglas heredadas de install-codex.ts: dry-run por defecto, apply con backup
// + journal, restore desde el journal. Nunca se tocan secretos.
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { availableRoutes, resolveLimits } from "./web-models";
import { parseCapabilities as parseCaps } from "./config";

export interface TuiInfo {
  id: string;
  label: string;
  configDir: string;
  configPath?: string;
  bin?: string;
  present: boolean;
  installable: boolean;
}

const HOME = homedir();

function which(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const full = join(dir, bin);
    if (full && existsSync(full)) return full;
  }
  return undefined;
}

/** Inventario: config dir y/o binario en PATH. Solo opencode es instalable. */
export function detectTuis(home: string = HOME): TuiInfo[] {
  const table: Array<Omit<TuiInfo, "present" | "installable">> = [
    { id: "opencode", label: "opencode/OpenISy", configDir: join(home, ".config", "opencode"), configPath: join(home, ".config", "opencode", "opencode.json"), bin: which("opencode") },
    { id: "codex", label: "Codex", configDir: join(home, ".codex") },
    { id: "hermes", label: "Hermes", configDir: join(home, ".hermes") },
    { id: "openclaw", label: "OpenClaw", configDir: join(home, ".openclaw") },
    { id: "qwen", label: "Qwen", configDir: join(home, ".qwen") },
    { id: "copilot", label: "Copilot", configDir: join(home, ".copilot") },
    { id: "pi", label: "Pi", configDir: join(home, ".pi") },
    { id: "fx", label: "fx", configDir: join(home, ".fx") },
    { id: "claude", label: "Claude Code", configDir: join(home, ".claude") },
    { id: "gemini", label: "Gemini", configDir: join(home, ".gemini") },
    { id: "cursor", label: "Cursor", configDir: join(home, ".cursor") },
  ];
  return table.map((row) => ({
    ...row,
    present: existsSync(row.configDir) || Boolean(row.bin && existsSync(row.bin)),
    installable: row.id === "opencode",
  }));
}

export const OPENCODE_PROVIDER_ID = "isyco-web";
export const OPENCODE_MCP_ID = "isyco-web-http";

/** Filas Web como models de opencode, con su context window real. */
export function buildOpencodeModels(capsRaw?: string): Record<string, { name: string; limit: { context: number; output: number } }> {
  const caps = parseCaps(capsRaw ?? process.env.CODEX_WEB_HTTP_CAPS);
  const models: Record<string, { name: string; limit: { context: number; output: number } }> = {};
  for (const route of availableRoutes(caps)) {
    const context = resolveLimits(route.backendModel, route.defaultEffort, caps).contextWindow;
    // output es TECHO (= context), no medido por fila: opencode lo exige.
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
  const current = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
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
