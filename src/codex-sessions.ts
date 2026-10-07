// codex-sessions.ts — session tokens del MCP nativo (Codex ISyMCP).
//
// Un session token es una capacidad opaca ligada a un workspace y a un modo
// (read-only | writable). Sustituye al turn_token efimero que hoy exige el
// contrato nativo: cuando el broker no tiene un turno pendiente, un token que
// coincide con el registro ejecuta con la politica de esa sesion.
//
//   ~/.codex-web-http/codex-sessions.json   (0600, nunca versionado)
//
// Regla de secretos: el token completo solo se muestra al crearlo. En
// receipts, listados y logs se usa siempre el fingerprint sha256[:12].
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface CodexSession {
  token: string;
  fp: string;
  label: string;
  cwd: string;
  writable: boolean;
  createdAt: string;
  /** ISO; ausente = sesion anterior a v0.4 (sin caducidad). */
  expiresAt?: string | null;
  /**
   * "turn": token efimero de UN turno del chat local (Fase 2). Hereda cwd y
   * modo de su sesion padre, caduca en minutos y se revoca al terminar el
   * turno. Su fingerprint correlaciona cada tool call con ese turno exacto.
   */
  kind?: "turn";
  /** fp de la sesion padre (solo kind "turn"). */
  parent?: string;
  /** id del turno del chat local que lo acuño (solo kind "turn"). */
  turnId?: string;
}

interface Registry {
  schema: string;
  sessions: CodexSession[];
}

const SCHEMA = "codex-web-http.codex-sessions/1";

/** Caducidad por defecto de un session token (horas). */
export const DEFAULT_TTL_HOURS = 24 * 7;

export function bridgeHome(): string {
  return process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http");
}

export function registryPath(): string {
  return join(bridgeHome(), "codex-sessions.json");
}

export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function readRegistry(): Registry {
  const path = registryPath();
  if (!existsSync(path)) return { schema: SCHEMA, sessions: [] };
  let data: Partial<Registry>;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as Partial<Registry>;
  } catch (err) {
    // Fail closed: un registro ilegible no se pisa ni se ignora en silencio.
    throw new Error(`registro de sesiones ilegible (${path}): ${String(err)}`);
  }
  const sessions = Array.isArray(data.sessions)
    ? data.sessions.filter(
        (s): s is CodexSession =>
          Boolean(s) && typeof s.token === "string" && typeof s.cwd === "string",
      )
    : [];
  return { schema: typeof data.schema === "string" ? data.schema : SCHEMA, sessions };
}

function writeRegistry(reg: Registry): void {
  mkdirSync(bridgeHome(), { recursive: true });
  const path = registryPath();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function mintSession(
  cwd: string,
  options: { label?: string; writable?: boolean; ttlHours?: number } = {},
): CodexSession {
  if (!cwd || !isAbsolute(cwd)) throw new Error(`cwd debe ser una ruta absoluta: ${cwd || "(vacio)"}`);
  const abs = resolve(cwd);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`cwd no existe o no es un directorio: ${abs}`);
  }
  const ttlHours = options.ttlHours ?? DEFAULT_TTL_HOURS;
  if (!Number.isFinite(ttlHours) || ttlHours < 0) throw new Error(`ttl invalido: ${options.ttlHours}`);
  const token = randomBytes(32).toString("base64url");
  const session: CodexSession = {
    token,
    fp: fingerprint(token),
    label: options.label?.trim() || `session-${new Date().toISOString().slice(0, 19)}`,
    cwd: abs,
    writable: options.writable === true,
    createdAt: new Date().toISOString(),
    // ttl 0 = sin caducidad (explicito). El token viaja en el texto del chat,
    // asi que por defecto caduca.
    expiresAt: ttlHours > 0 ? new Date(Date.now() + ttlHours * 3_600_000).toISOString() : null,
  };
  const reg = readRegistry();
  reg.sessions.push(session);
  writeRegistry(reg);
  return session;
}

export function readSessions(): CodexSession[] {
  return readRegistry().sessions;
}

/** Sesiones que crea el usuario (sin los tokens efimeros de turno). */
export function listUserSessions(): CodexSession[] {
  return readRegistry().sessions.filter((s) => s.kind !== "turn");
}

export const TURN_TOKEN_TTL_MINUTES = 15;

/**
 * Acuña un token efimero para UN turno, derivado de una sesion del usuario.
 * Es lo unico que viaja a chatgpt.com en el chat local (el token de la sesion,
 * de dias, no sale). Limpia de paso los tokens de turno caducados.
 */
export function mintTurnToken(parentFp: string, turnId: string, ttlMinutes = TURN_TOKEN_TTL_MINUTES): CodexSession {
  const reg = readRegistry();
  const parent = reg.sessions.find((s) => s.fp === parentFp && s.kind !== "turn");
  if (!parent) throw new Error("sesion desconocida");
  if (isExpired(parent)) throw new Error("la sesion caduco");
  const token = randomBytes(32).toString("base64url");
  const turn: CodexSession = {
    token,
    fp: fingerprint(token),
    label: `turn:${turnId}`,
    cwd: parent.cwd,
    writable: parent.writable,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
    kind: "turn",
    parent: parent.fp,
    turnId,
  };
  reg.sessions = reg.sessions.filter((s) => !(s.kind === "turn" && isExpired(s)));
  reg.sessions.push(turn);
  writeRegistry(reg);
  return turn;
}

/** Revoca un token de turno por fp exacto (fin del turno). */
export function revokeTurnToken(fp: string): void {
  const reg = readRegistry();
  const before = reg.sessions.length;
  reg.sessions = reg.sessions.filter((s) => !(s.kind === "turn" && s.fp === fp));
  if (reg.sessions.length !== before) writeRegistry(reg);
}

/** Prefijo minimo para revocar: con menos, un typo se lleva sesiones ajenas. */
export const MIN_REVOKE_PREFIX = 6;

export function revokeSession(prefixOrFp: string): number {
  const needle = prefixOrFp.trim();
  if (!needle) throw new Error("revoke requiere un token o su fingerprint");
  if (needle.length < MIN_REVOKE_PREFIX) {
    throw new Error(`revoke requiere al menos ${MIN_REVOKE_PREFIX} caracteres de token o fingerprint`);
  }
  const reg = readRegistry();
  const matches = reg.sessions.filter((s) => s.token.startsWith(needle) || s.fp.startsWith(needle));
  if (matches.length > 1) {
    throw new Error(`prefijo ambiguo: coincide con ${matches.length} sesiones (${matches.map((s) => s.fp).join(", ")}); usa mas caracteres`);
  }
  if (matches.length === 0) return 0;
  const gone = matches[0]!;
  // Cascada: los tokens de turno de esa sesion mueren con ella.
  reg.sessions = reg.sessions.filter((s) => s !== gone && s.parent !== gone.fp);
  writeRegistry(reg);
  return 1;
}

export function isExpired(session: Pick<CodexSession, "expiresAt">, now = Date.now()): boolean {
  if (!session.expiresAt) return false;
  const at = Date.parse(session.expiresAt);
  return Number.isNaN(at) || at <= now;
}

export function findSessionByToken(token: string): CodexSession | null {
  if (!token) return null;
  const sessions = readRegistry().sessions;
  for (const session of sessions) {
    const a = Buffer.from(session.token);
    const b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      if (isExpired(session)) return null;
      if (session.kind === "turn") {
        // Un token de turno no sobrevive a su sesion padre.
        const parent = sessions.find((p) => p.fp === session.parent && p.kind !== "turn");
        if (!parent || isExpired(parent)) return null;
      }
      return session;
    }
  }
  return null;
}

/** Ruta confinada: resuelve `candidate` dentro de `root`; null si se escapa. */
export function resolveWithin(root: string, candidate: string): string | null {
  const resolved = candidate ? resolve(root, candidate) : resolve(root);
  const rel = relative(root, resolved);
  if (rel === "") return resolved;
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

/**
 * Como resolveWithin, pero ademas sigue symlinks del path existente: un link
 * dentro del workspace que apunta afuera se niega.
 */
export function resolveWithinReal(root: string, candidate: string): string | null {
  const lexical = resolveWithin(root, candidate);
  if (!lexical || !existsSync(lexical)) return lexical;
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(lexical);
  } catch {
    return null;
  }
  return resolveWithin(realRoot, realTarget) ? lexical : null;
}

export const BWRAP = "/usr/bin/bwrap";

export function sandboxAvailable(): boolean {
  if (sandboxDisabledByOperator()) return false;
  return existsSync(BWRAP);
}

/** CODEX_WEB_HTTP_SANDBOX=off: el operador apaga bwrap A PROPOSITO. */
export function sandboxDisabledByOperator(): boolean {
  return process.env.CODEX_WEB_HTTP_SANDBOX?.trim() === "off";
}

/**
 * Toolchains bajo $HOME que se re-exponen en solo-lectura encima del tmpfs
 * (sin ellas `bun`, `cargo`... desaparecen del PATH). Ninguna guarda
 * credenciales: de ~/.cargo solo va bin/, nunca credentials.toml.
 * Extra: CODEX_WEB_HTTP_SANDBOX_RO_BINDS="ruta1,ruta2" (relativas a $HOME o
 * absolutas).
 */
const HOME_TOOLCHAINS = [".bun", ".local/bin", ".local/opt", ".cargo/bin", ".rustup", ".nvm", "go/bin", ".deno/bin"];

function toolchainBinds(home: string): string[] {
  const extra = (process.env.CODEX_WEB_HTTP_SANDBOX_RO_BINDS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const entry of [...HOME_TOOLCHAINS, ...extra]) {
    const abs = isAbsolute(entry) ? entry : join(home, entry);
    if (existsSync(abs)) out.push("--ro-bind", abs, abs);
  }
  return out;
}

/** Variables que el comando ve dentro de la burbuja (el resto se borra). */
const SANDBOX_ENV_KEEP = ["PATH", "LANG", "LC_ALL", "TERM", "TZ"];

function sandboxEnv(home: string): string[] {
  const out: string[] = [];
  const extra = (process.env.CODEX_WEB_HTTP_SANDBOX_ENV ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of [...SANDBOX_ENV_KEEP, ...extra]) {
    const value = process.env[name];
    if (value !== undefined) out.push("--setenv", name, value);
  }
  out.push("--setenv", "HOME", home);
  return out;
}

/**
 * argv de bwrap para una sesion.
 *
 * Read-only: root solo-lectura, pero $HOME y el home del bridge (tokens,
 * cookies) quedan tapados por tmpfs; sin red; env minimo. Solo el workspace
 * se vuelve a exponer (ro, o rw si la sesion es writable).
 *
 * Sin bwrap devuelve null (fail closed) para read-only Y para writable, salvo
 * que el operador haya apagado el sandbox explicitamente
 * (CODEX_WEB_HTTP_SANDBOX=off), en cuyo caso writable corre sin burbuja.
 * Red opt-in: CODEX_WEB_HTTP_SANDBOX_NET=1.
 */
export function sandboxArgv(
  session: Pick<CodexSession, "cwd" | "writable">,
  workdir: string,
  command: string[],
): string[] | null {
  if (!sandboxAvailable()) {
    if (session.writable && sandboxDisabledByOperator()) return [...command];
    return null;
  }
  const home = homedir();
  const args = [
    BWRAP,
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", home,
  ];
  // Secretos del bridge fuera de $HOME (CODEX_WEB_HTTP_HOME) tambien se tapan.
  const secrets = bridgeHome();
  if (existsSync(secrets) && resolveWithin(home, secrets) === null) {
    args.push("--tmpfs", secrets);
  }
  args.push(...toolchainBinds(home));
  args.push("--unshare-all");
  if (process.env.CODEX_WEB_HTTP_SANDBOX_NET?.trim() === "1") args.push("--share-net");
  args.push("--die-with-parent", "--new-session", "--clearenv", ...sandboxEnv(home));
  // Re-exponer el workspace DESPUES de los tmpfs: si vive bajo /tmp o $HOME
  // el tmpfs lo taparia y --chdir fallaria.
  args.push(session.writable ? "--bind" : "--ro-bind", session.cwd, session.cwd);
  // Si el workspace contiene el home del bridge (p. ej. cwd=$HOME), taparlo
  // otra vez encima del bind.
  if (existsSync(secrets) && resolveWithin(session.cwd, secrets) !== null) {
    args.push("--tmpfs", secrets);
  }
  args.push("--chdir", workdir, "--", ...command);
  return args;
}

/**
 * Paths tocados por un patch. Soporta diff unificado (--- a/x, +++ b/x) y
 * detecta el formato *** Begin Patch (no soportado en v0).
 */
export function patchPaths(patch: string): { paths: string[]; codexFormat: boolean } {
  const paths: string[] = [];
  let codexFormat = false;
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const codex = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (codex) {
      codexFormat = true;
      paths.push(codex[1].trim());
      continue;
    }
    const unified = line.match(/^(?:\+\+\+|---) ([^\t]+)(?:\t.*)?$/);
    if (unified) {
      const target = unified[1].trim();
      if (target === "/dev/null") continue;
      const stripped = target.replace(/^[ab]\//, "");
      paths.push(stripped);
    }
  }
  return { paths, codexFormat };
}
