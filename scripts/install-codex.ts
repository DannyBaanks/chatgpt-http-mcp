// Legacy TOML helpers remain available to callers. Global bridge installation
// is disabled: the executable prepares an isolated ISyMCP profile instead.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_URL = "http://127.0.0.1:8791/v1";

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function defaultConfigPath(): string {
  const home = process.env.CODEX_HOME?.trim();
  return home ? join(home, "config.toml") : join(homedir(), ".codex", "config.toml");
}

/** Reemplaza/inserta una clave top-level respetando las tablas TOML. */
export function setTopLevelTomlString(text: string, key: string, value: string): string {
  const lines = text.length ? text.split("\n") : [];
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  let firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTable < 0) firstTable = lines.length;
  const replacement = `${key} = ${JSON.stringify(value)}`;
  for (let i = 0; i < firstTable; i++) {
    if (keyRe.test(lines[i])) {
      lines[i] = replacement;
      return lines.join("\n");
    }
  }
  lines.splice(firstTable, 0, replacement);
  return lines.join("\n");
}

/** Devuelve el valor top-level actual (o null si no existe). */
export function getTopLevelTomlString(text: string, key: string): string | null {
  const keyRe = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const m = keyRe.exec(line);
    if (m) return m[1].trim().replace(/^"|"$/g, "");
  }
  return null;
}

export interface InstallResult {
  action: "dry-run" | "apply" | "restore";
  configPath: string;
  url: string;
  previous: string | null;
  backupPath?: string;
}

export function install(options: {
  configPath?: string;
  url?: string;
  apply?: boolean;
  restore?: boolean;
  backupDir?: string;
}): InstallResult {
  if (options.apply || options.restore) {
    throw new Error("instalacion global desactivada; usa isymcp models apply para preparar un perfil aislado");
  }
  const configPath = resolve(options.configPath ?? defaultConfigPath());
  const url = options.url ?? DEFAULT_URL;
  const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const previous = getTopLevelTomlString(original, "openai_base_url");
  return { action: "dry-run", configPath, url, previous };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--config")) throw new Error("--config global desactivado; usa --codex-home (solo lectura) y --profile-dir para el perfil aislado");
  const { installWebModels } = await import("./install-web-models");
  const result = installWebModels({
    codexHome: argValue(args, "--codex-home"),
    profileDir: argValue(args, "--profile-dir"),
    url: argValue(args, "--url"),
    model: argValue(args, "--model"),
    effort: argValue(args, "--effort"),
    caps: argValue(args, "--caps"),
    apply: args.includes("--apply"),
    restore: args.includes("--restore"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.action === "dry-run") {
    console.log("(dry-run: --apply prepara el perfil aislado de ISyMCP; Codex nativo conserva su configuracion)");
  }
}
