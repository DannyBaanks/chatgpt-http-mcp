// config.ts — configuracion del grupo tablero_*: apagada por defecto, fail closed.
//
// Las tools tablero_* dejan que el modelo (p. ej. ChatGPT desde el celular)
// administre un Tablero de coordinacion y lance consolas de agentes. Lanzar una
// consola con un prompt equivale a ejecutar codigo, asi que lo que el modelo
// puede lanzar NO lo decide el modelo: sale de este archivo, que solo el
// usuario escribe (~/.codex-web-http/tablero.json, 0600).
//
// Reglas que se validan en CADA llamada (apagarlo surte efecto al instante):
//   - archivo regular, del usuario, sin escritura para grupo/otros;
//   - enabled === true;
//   - cada lanzador es un argv fijo con un unico "{prompt}" y sin flags que
//     apaguen los permisos del agente (--dangerously-skip-permissions, --auto...);
//   - el cwd de cada lanzador vive dentro de allowedRoots;
//   - la identidad del modelo nunca es "danny" (firma como si mismo).
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { bridgeHome } from "../codex-sessions";

export interface Launcher {
  argv: string[];
  cwd: string;
}

export interface TableroConfig {
  path: string;
  tableroDir: string;
  python: string;
  identity: string;
  allowedRoots: string[];
  maxLive: number;
  maxPerHour: number;
  passEnv: string[];
  launchers: Record<string, Launcher>;
}

export class TableroConfigError extends Error {
  constructor(readonly code: "tablero_not_configured" | "tablero_disabled" | "tablero_config_invalid", message: string) {
    super(message);
  }
}

export const PROMPT_SLOT = "{prompt}";
export const RESERVED_IDENTITIES = new Set(["danny", "human", "admin", "root"]);

/**
 * Flags o valores que apagan el sistema de permisos del agente lanzado:
 * claude/agy --dangerously-skip-permissions, --permission-mode bypassPermissions,
 * codex --sandbox danger-full-access / --ask-for-approval never / --full-auto,
 * opencode --auto, gemini --yolo / -y.
 */
const FORBIDDEN_FLAG = /danger|skip-permissions|bypass|yolo|^--auto$|^--full-auto$|^--allow-all|^-y$|^never$/i;

/** Variables que la consola hereda por defecto (todo lo demas se borra con env -i). */
const DEFAULT_PASS_ENV = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_ALL", "TERM", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY",
  "WAYLAND_DISPLAY"];
/** Nunca pasan a la consola, aunque el usuario las pida: son credenciales del bridge o de APIs. */
const SECRET_ENV = /^CODEX_WEB_HTTP_|TOKEN|SECRET|PASSWORD|API_KEY|^OPENAI_|^ANTHROPIC_|COOKIE/i;

export function tableroConfigPath(): string {
  return process.env.ISYMCP_TABLERO_CONFIG?.trim() || join(bridgeHome(), "tablero.json");
}

export function tableroConfigured(): boolean {
  return existsSync(tableroConfigPath());
}

function invalid(message: string): never {
  throw new TableroConfigError("tablero_config_invalid", message);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realDir(path: string, what: string): string {
  if (!isAbsolute(path)) invalid(`${what} debe ser ruta absoluta: ${path}`);
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    invalid(`${what} no existe: ${path}`);
  }
  if (!statSync(real).isDirectory()) invalid(`${what} no es un directorio: ${path}`);
  return real;
}

function intIn(value: unknown, fallback: number, min: number, max: number, what: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) invalid(`${what} debe ser entero ${min}..${max}`);
  return value as number;
}

function checkFilePrivate(path: string): void {
  const st = lstatSync(path);
  if (!st.isFile()) invalid(`${path} debe ser un archivo regular (no symlink)`);
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) invalid(`${path} no es del usuario actual`);
  if (st.mode & 0o022) invalid(`${path} es escribible por grupo/otros: chmod 600 ${path}`);
}

function checkLauncher(name: string, raw: unknown, roots: string[]): Launcher {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) invalid(`nombre de lanzador invalido: ${name}`);
  const l = raw as Partial<Launcher> | null;
  if (!l || !Array.isArray(l.argv) || l.argv.length === 0 || !l.argv.every((a) => typeof a === "string" && a.length > 0)) {
    invalid(`lanzador ${name}: argv debe ser una lista no vacia de strings`);
  }
  const [bin] = l.argv;
  if (!isAbsolute(bin!)) invalid(`lanzador ${name}: argv[0] debe ser ruta absoluta (${bin})`);
  try {
    accessSync(bin!, constants.X_OK);
  } catch {
    invalid(`lanzador ${name}: ${bin} no existe o no es ejecutable`);
  }
  if (l.argv.filter((a) => a === PROMPT_SLOT).length !== 1) invalid(`lanzador ${name}: argv necesita exactamente un "${PROMPT_SLOT}"`);
  for (const arg of l.argv) {
    if (arg !== PROMPT_SLOT && /[{}]/.test(arg)) invalid(`lanzador ${name}: solo se admite el hueco ${PROMPT_SLOT} (${arg})`);
    if (FORBIDDEN_FLAG.test(arg)) invalid(`lanzador ${name}: ${arg} apaga los permisos del agente; no se permite`);
  }
  if (typeof l.cwd !== "string") invalid(`lanzador ${name}: falta cwd`);
  const cwd = realDir(l.cwd, `lanzador ${name}: cwd`);
  if (!roots.some((root) => within(root, cwd))) invalid(`lanzador ${name}: cwd ${cwd} esta fuera de allowedRoots`);
  return { argv: [...l.argv], cwd };
}

/** Carga y valida la configuracion; lanza TableroConfigError si no se puede usar. */
export function loadTableroConfig(path = tableroConfigPath()): TableroConfig {
  if (!existsSync(path)) {
    throw new TableroConfigError("tablero_not_configured", `no hay ${path}: el grupo tablero_* esta apagado (ver GUIA "Tablero")`);
  }
  checkFilePrivate(path);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    invalid(`${path} no es JSON valido: ${(error as Error).message}`);
  }
  if (raw.enabled !== true) throw new TableroConfigError("tablero_disabled", "tablero apagado (enabled != true). Enciendelo con: isymcp tablero on");
  const tableroDir = realDir(String(raw.tableroDir ?? ""), "tableroDir");
  if (!existsSync(join(tableroDir, "tablero.py"))) invalid(`tableroDir no contiene tablero.py: ${tableroDir}`);
  const python = String(raw.python ?? Bun.which("python3") ?? "");
  if (!isAbsolute(python) || !existsSync(python)) invalid(`python debe ser ruta absoluta existente: ${python || "(no encontrado)"}`);
  const identity = String(raw.identity ?? "gpt_mano_derecha");
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(identity) || RESERVED_IDENTITIES.has(identity)) {
    invalid(`identity invalida: ${identity} (el modelo firma como si mismo, nunca como el humano)`);
  }
  if (raw.allowedRoots !== undefined && !Array.isArray(raw.allowedRoots)) invalid("allowedRoots debe ser una lista");
  const allowedRoots = ((raw.allowedRoots as unknown[] | undefined) ?? []).map((r) => realDir(String(r), "allowedRoots"));
  const launchersRaw = (raw.launchers ?? {}) as Record<string, unknown>;
  if (typeof launchersRaw !== "object" || Array.isArray(launchersRaw)) invalid("launchers debe ser un objeto");
  if (Object.keys(launchersRaw).length && !allowedRoots.length) invalid("hay launchers pero allowedRoots esta vacio");
  const launchers: Record<string, Launcher> = {};
  for (const [name, l] of Object.entries(launchersRaw)) launchers[name] = checkLauncher(name, l, allowedRoots);
  const extraEnv = raw.passEnv === undefined ? [] : raw.passEnv;
  if (!Array.isArray(extraEnv) || !extraEnv.every((v) => typeof v === "string" && /^[A-Z_][A-Z0-9_]*$/.test(v))) invalid(
    "passEnv debe ser lista de nombres de variable");
  const secret = (extraEnv as string[]).find((v) => SECRET_ENV.test(v));
  if (secret) invalid(`passEnv no puede incluir credenciales: ${secret}`);
  return {
    path,
    tableroDir,
    python,
    identity,
    allowedRoots,
    maxLive: intIn(raw.maxLive, 2, 1, 8, "maxLive"),
    maxPerHour: intIn(raw.maxPerHour, 6, 1, 30, "maxPerHour"),
    passEnv: [...new Set([...DEFAULT_PASS_ENV, ...(extraEnv as string[])])].filter((v) => !SECRET_ENV.test(v)),
    launchers,
  };
}
