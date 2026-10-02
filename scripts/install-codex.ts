// install-codex.ts — integra este server como openai_base_url de Codex.
//
// Seguro por defecto: sin --apply solo muestra el cambio (dry-run). Con
// --apply hace backup del config antes de escribir; --restore restaura el
// backup mas reciente. Nunca toca auth.json ni otros archivos de ~/.codex.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  const configPath = resolve(options.configPath ?? defaultConfigPath());
  const backupDir = resolve(options.backupDir ?? join(import.meta.dir, "..", "backups"));
  const url = options.url ?? DEFAULT_URL;

  if (options.restore) {
    const latest = join(backupDir, "latest.json");
    if (!existsSync(latest)) throw new Error(`no hay backup en ${backupDir}`);
    const journal = JSON.parse(readFileSync(latest, "utf8")) as { backupPath: string; configPath: string };
    copyFileSync(journal.backupPath, journal.configPath);
    return {
      action: "restore",
      configPath: journal.configPath,
      url,
      previous: null,
      backupPath: journal.backupPath,
    };
  }

  const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const previous = getTopLevelTomlString(original, "openai_base_url");
  if (!options.apply) {
    return { action: "dry-run", configPath, url, previous };
  }

  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `config.toml.${stamp}`);
  writeFileSync(backupPath, original);
  writeFileSync(configPath, setTopLevelTomlString(original, "openai_base_url", url));
  writeFileSync(join(backupDir, "latest.json"), JSON.stringify({ configPath, backupPath, previous }, null, 2));

  return { action: "apply", configPath, url, previous, backupPath };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const result = install({
    configPath: argValue(args, "--config"),
    url: argValue(args, "--url"),
    apply: args.includes("--apply"),
    restore: args.includes("--restore"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.action === "dry-run") {
    console.log("(dry-run: usa --apply para escribir, con backup)");
  }
}
