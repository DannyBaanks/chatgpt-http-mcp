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
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter as pathDelimiter, isAbsolute, join, relative, resolve } from "node:path";
import { buildCodexWindowsSandboxPlan, cleanupCodexWindowsSandboxPath, findCodexWindowsCli } from "./platform/codex-windows-sandbox";
import { buildWindowsDockerSandboxPlan } from "./platform/docker-sandbox";
import { ensurePrivatePath, securePrivatePath } from "./platform/private-path";

export interface CodexSession {
  /** Explicit native owner; never inferred from a model, port or token prefix. */
  nativeOwner?: {
    socketPath: string; socketDevice: number; socketInode: number; ownerToken: string;
    owner: { launchId: string; threadId: string; turnId: string; epoch: string };
    phase: "prepared" | "active" | "completed";
    source?: { url: string; messageId: string };
    response?: string;
    /** Fixed diagnostic operation, not an expanded general execution grant. */
    canary?: { marker: string; hostSandbox: "dangerFullAccess" };
  };
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
  /** Explicit CLI authorization of one local task; changed content fails closed. */
  request?: { filename: string; sha256: string };
}

interface Registry {
  schema: string;
  sessions: CodexSession[];
}

const SCHEMA = "codex-web-http.codex-sessions/1";

/** Caducidad por defecto de un session token (horas). */
export const DEFAULT_TTL_HOURS = 24;

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
    ensurePrivatePath(path, false);
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
  securePrivatePath(bridgeHome(), true);
  const path = registryPath();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  securePrivatePath(path, false);
}

const REGISTRY_LOCK_WAIT_MS = 10_000;
const REGISTRY_LOCK_STALE_MS = 30_000;

/**
 * Exclusion entre procesos para leer-modificar-escribir el registro: el bridge
 * acuña y revoca tokens de turno, el MCP marca sesiones nativas y el CLI
 * revoca. Sin lock, la ultima copia escrita pisa a las demas y un revoke
 * puede deshacerse. Un lock abandonado (proceso muerto) caduca a los 30 s.
 */
function withRegistryLock<T>(work: () => T): T {
  mkdirSync(bridgeHome(), { recursive: true });
  securePrivatePath(bridgeHome(), true);
  const lock = `${registryPath()}.lock`;
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > REGISTRY_LOCK_STALE_MS) { unlinkSync(lock); continue; }
      } catch { continue; /* el dueño lo solto entre medias */ }
      if (Date.now() > deadline) throw new Error(`registro de sesiones bloqueado (${lock}); si ningun isymcp esta corriendo, borra ese archivo`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return work();
  } finally {
    closeSync(fd);
    try { unlinkSync(lock); } catch { /* ya no existe */ }
  }
}

export function mintSession(
  cwd: string,
  options: { label?: string; writable?: boolean; ttlHours?: number; requestFile?: string } = {},
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
  if (options.requestFile !== undefined) {
    const filename = relative(abs, resolve(abs, options.requestFile));
    const local = readLocalRequest(session, filename);
    session.request = { filename, sha256: local.sha256 };
  }
  withRegistryLock(() => {
    const reg = readRegistry();
    reg.sessions.push(session);
    writeRegistry(reg);
  });
  return session;
}

/** No MCP path argument: the local user binds the file when minting the token. */
function readLocalRequest(session: CodexSession, filename: string): { filename: string; sha256: string; content: string } {
  if (!filename || filename.length > 4096 || filename.includes("\0") || isAbsolute(filename) || filename.split(/[\\/]/).includes(".."))
    throw new Error("session_request_outside_workspace: request must be a file within the authorized workspace");
  const root = realpathSync(session.cwd);
  const path = resolve(root, filename);
  if (!resolveWithin(root, filename)) throw new Error("session_request_outside_workspace");
  let fd: number | undefined;
  try {
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
    fd = openSync(path, flags);
    // Bind the safety check to the opened file, including symlink parents.
    const opened = process.platform === "win32" ? realpathSync(path) : realpathSync(`/proc/self/fd/${fd}`);
    const inside = relative(root, opened);
    if (!inside || isAbsolute(inside) || inside.split(/[\\/]/).includes("..")) throw new Error("session_request_outside_workspace");
    const openedStat = fstatSync(fd);
    if (!openedStat.isFile()) throw new Error("session_request_invalid: request must be a regular text file");
    if (process.platform === "win32") {
      const pathStat = statSync(path);
      if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) throw new Error("session_request_outside_workspace");
    }
    const bytes = Buffer.alloc(65537);
    let size = 0, count = 0;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count;
    if (size > 65536) throw new Error("session_request_too_large: maximum 64 KiB");
    const data = bytes.subarray(0, size);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
    catch { throw new Error("session_request_invalid: request must be UTF-8 text"); }
    if (!content.trim() || content.includes("\0")) throw new Error("session_request_invalid: request must contain usable text");
    return { filename, content, sha256: createHash("sha256").update(data).digest("hex") };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readSessionRequest(session: CodexSession): { filename: string; sha256: string; content: string } | null {
  if (!session.request) return null;
  const local = readLocalRequest(session, session.request.filename);
  if (local.sha256 !== session.request.sha256) throw new Error("session_request_changed: mint a new token to authorize the changed task");
  return local;
}

export function readSessions(): CodexSession[] {
  return readRegistry().sessions;
}

/** Local controller only. This function is not exposed as an MCP tool. */
export function updateSession(fp: string, update: (session: CodexSession) => void): CodexSession {
  return withRegistryLock(() => {
    const registry = readRegistry();
    const session = registry.sessions.find(s => s.fp === fp);
    if (!session) throw new Error("session_not_registered");
    update(session); writeRegistry(registry); return session;
  });
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
  return withRegistryLock(() => mintTurnTokenLocked(parentFp, turnId, ttlMinutes));
}

function mintTurnTokenLocked(parentFp: string, turnId: string, ttlMinutes: number): CodexSession {
  const reg = readRegistry();
  const parent = reg.sessions.find((s) => s.fp === parentFp && s.kind !== "turn");
  if (!parent) throw new Error("sesion desconocida");
  if (isExpired(parent)) throw new Error("la sesion caduco");
  if (parent.nativeOwner) throw new Error("native_owner_requires_its_exact_turn_token");
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
    ...(parent.request ? { request: parent.request } : {}),
  };
  reg.sessions = reg.sessions.filter((s) => !(s.kind === "turn" && isExpired(s)));
  reg.sessions.push(turn);
  writeRegistry(reg);
  return turn;
}

/** Revoca un token de turno por fp exacto (fin del turno). */
export function revokeTurnToken(fp: string): void {
  withRegistryLock(() => {
    const reg = readRegistry();
    const before = reg.sessions.length;
    reg.sessions = reg.sessions.filter((s) => !(s.kind === "turn" && s.fp === fp));
    if (reg.sessions.length !== before) writeRegistry(reg);
  });
}

/** Prefijo minimo para revocar: con menos, un typo se lleva sesiones ajenas. */
export const MIN_REVOKE_PREFIX = 6;

export function revokeSession(prefixOrFp: string): number {
  const needle = prefixOrFp.trim();
  if (!needle) throw new Error("revoke requiere un token o su fingerprint");
  if (needle.length < MIN_REVOKE_PREFIX) {
    throw new Error(`revoke requiere al menos ${MIN_REVOKE_PREFIX} caracteres de token o fingerprint`);
  }
  return withRegistryLock(() => revokeSessionLocked(needle));
}

function revokeSessionLocked(needle: string): number {
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
      // Retain native tombstones so expiry/closure is an explicit native error,
      // never a compatibility stub or a switch to the standalone sandbox.
      if (isExpired(session) && !session.nativeOwner) return null;
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
export const DEFAULT_WINDOWS_SANDBOX_IMAGE = "isymcp-sandbox:1.0.0-rc.2";

export interface SandboxPlan {
  argv: string[];
  backend: "bwrap" | "docker" | "codex-windows" | "none";
  containerName?: string;
  env?: Record<string, string>;
  cleanupRoot?: string;
  watched?: boolean;
}

const liveDockerContainers = new Map<string, string>();
let dockerProbeCache: { image: string; until: number; available: boolean } | null = null;

function dockerPath(): string | null {
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const directory of (process.env.PATH ?? "").split(pathDelimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `docker${extension.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
    const extensionless = join(directory, "docker");
    if (existsSync(extensionless)) return extensionless;
  }
  return null;
}

function dockerImageAvailable(): boolean {
  const image = process.env.CODEX_WEB_HTTP_SANDBOX_IMAGE?.trim() || DEFAULT_WINDOWS_SANDBOX_IMAGE;
  if (dockerProbeCache?.image === image && dockerProbeCache.until > Date.now()) return dockerProbeCache.available;
  const executable = dockerPath();
  let available = false;
  if (executable) {
    try {
      const result = Bun.spawnSync([executable, "image", "inspect", image, "--format={{.Id}}"], {
        stdout: "pipe", stderr: "ignore", timeout: 2500,
      });
      available = result.exitCode === 0 && result.stdout.toString().trim().length > 0;
    } catch { /* daemon or image unavailable: remain fail-closed */ }
  }
  dockerProbeCache = { image, until: Date.now() + 5000, available };
  return available;
}

function dockerContainerName(argv: string[]): string | null {
  const index = argv.indexOf("--name");
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function stopDockerContainer(executable: string, name: string): void {
  try {
    Bun.spawnSync([executable, "kill", name], { stdout: "ignore", stderr: "ignore", timeout: 5000 });
  } catch { /* daemon may already have removed it */ }
}

function reapDockerContainer(name: string, executable: string): void {
  try {
    const status = Bun.spawnSync([executable, "inspect", "--format={{.State.Running}}", name], {
      stdout: "pipe", stderr: "ignore", timeout: 2500,
    });
    if (status.exitCode === 0 && status.stdout.toString().trim() === "true") stopDockerContainer(executable, name);
  } catch { /* preserve the original command result */ }
  liveDockerContainers.delete(name);
}

process.once("exit", () => {
  for (const [name, executable] of liveDockerContainers) stopDockerContainer(executable, name);
});

export function sandboxAvailable(): boolean {
  return sandboxBackend() !== "none";
}

export function sandboxBackend(): SandboxPlan["backend"] {
  if (sandboxDisabledByOperator()) return "none";
  if (process.platform === "win32") {
    const selected = process.env.CODEX_WEB_HTTP_WINDOWS_SANDBOX_BACKEND?.trim().toLowerCase() || "docker";
    if (selected === "native") return findCodexWindowsCli() ? "codex-windows" : "none";
    if (selected === "docker") return dockerImageAvailable() ? "docker" : "none";
    return "none";
  }
  return existsSync(BWRAP) ? "bwrap" : "none";
}

export function sandboxLabel(session: Pick<CodexSession, "writable">): string {
  const backend = sandboxBackend();
  if (backend === "codex-windows") return session.writable ? "codex-windows-workspace-write" : "codex-windows-read-only";
  if (backend === "docker") return session.writable ? "docker-linux-workspace-write" : "docker-linux-read-only";
  if (backend === "bwrap") return session.writable ? "bwrap-workspace-write" : "bwrap-read-only";
  return "none";
}

export function sandboxUnavailableReason(): string {
  if (sandboxDisabledByOperator()) return "sandbox apagado explícitamente por CODEX_WEB_HTTP_SANDBOX=off";
  if (process.platform === "win32") {
    const selected = process.env.CODEX_WEB_HTTP_WINDOWS_SANDBOX_BACKEND?.trim().toLowerCase() || "docker";
    if (selected === "native") {
      if (!findCodexWindowsCli()) return "falta Codex CLI nativo; instala @openai/codex o define ISYMCP_CODEX_CLI_BIN";
      return "el sandbox nativo de Codex Windows no está provisionado; ejecútalo desde PowerShell y acepta su configuración inicial de seguridad";
    }
    if (selected !== "docker") return "CODEX_WEB_HTTP_WINDOWS_SANDBOX_BACKEND debe ser native o docker";
    const image = process.env.CODEX_WEB_HTTP_SANDBOX_IMAGE?.trim() || DEFAULT_WINDOWS_SANDBOX_IMAGE;
    return `Docker Desktop o la imagen ${image} no están disponibles; ejecuta bun run sandbox:build`;
  }
  return "bubblewrap no está disponible";
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

/**
 * Rutas del host tapadas con tmpfs encima de `--ro-bind / /`.
 *
 * /run y /var/run guardan sockets Unix con ruta (D-Bus de sesion y de sistema,
 * systemd --user, docker.sock). --unshare-net no los corta y conectar a un
 * socket no es "escribir", asi que el ro-bind no protegia: un comando llegaba
 * a `systemd-run --user` (ejecutar fuera de la burbuja) o a docker (root si el
 * usuario esta en el grupo docker). Tapado en #35 (2026-10-23), demostrado otra
 * vez 2026-10-28. Tambien: /var/log (se lee con el grupo adm) y, con red
 * opt-in, el resolv.conf que vive bajo /run.
 */
const HOST_MASKS = ["/run", "/var/run", "/var/log"];

export function hostSocketMasks(shareNet = false): string[] {
  const masked = new Set<string>();
  for (const path of HOST_MASKS) {
    let real: string;
    try {
      real = realpathSync(path); // /var/run -> /run en Ubuntu: un solo tmpfs
    } catch {
      continue;
    }
    if (statSync(real).isDirectory()) masked.add(real);
  }
  const out: string[] = [];
  for (const dir of masked) out.push("--tmpfs", dir);
  // Con red opt-in, /etc/resolv.conf suele apuntar a /run/systemd/resolve/:
  // re-exponer solo ese archivo (ro), no el directorio ni su socket.
  if (shareNet) {
    try {
      const resolv = realpathSync("/etc/resolv.conf");
      if ([...masked].some((dir) => resolveWithin(dir, resolv) !== null)) out.push("--ro-bind", resolv, resolv);
    } catch {
      // sin resolv.conf no hay nada que re-exponer
    }
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
export function sandboxPlan(
  session: Pick<CodexSession, "cwd" | "writable">,
  workdir: string,
  command: string[],
  options: { readPaths?: string[] } = {},
): SandboxPlan | null {
  const backend = sandboxBackend();
  if (backend === "none") {
    if (session.writable && sandboxDisabledByOperator()) return { argv: [...command], backend: "none" };
    return null;
  }
  if (backend === "codex-windows") {
    try {
      const native = buildCodexWindowsSandboxPlan({
        workspace: session.cwd,
        workdir,
        bridgeHome: bridgeHome(),
        command,
        writable: session.writable,
        network: process.env.CODEX_WEB_HTTP_SANDBOX_NET?.trim() === "1",
        readPaths: options.readPaths,
      });
      return { ...native, backend };
    } catch {
      return null;
    }
  }
  if (backend === "docker") {
    const executable = dockerPath();
    if (!executable) return null;
    const containerName = `isymcp-${process.pid}-${randomUUID().replaceAll("-", "")}`;
    const image = process.env.CODEX_WEB_HTTP_SANDBOX_IMAGE?.trim() || DEFAULT_WINDOWS_SANDBOX_IMAGE;
    try {
      const plan = buildWindowsDockerSandboxPlan({
        dockerPath: executable,
        image,
        workspace: session.cwd,
        workdir,
        bridgeHome: bridgeHome(),
        sourceRoot: import.meta.dir,
        command,
        writable: session.writable,
        env: process.env,
        containerName,
      });
      liveDockerContainers.set(containerName, executable);
      return { argv: plan.argv, backend, containerName };
    } catch {
      return null;
    }
  }
  const home = homedir();
  const shareNet = process.env.CODEX_WEB_HTTP_SANDBOX_NET?.trim() === "1";
  const args = [
    BWRAP,
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", home,
    ...hostSocketMasks(shareNet),
  ];
  // Secretos del bridge fuera de $HOME (CODEX_WEB_HTTP_HOME) tambien se tapan.
  const secrets = bridgeHome();
  if (existsSync(secrets) && resolveWithin(home, secrets) === null) {
    args.push("--tmpfs", secrets);
  }
  args.push(...toolchainBinds(home));
  args.push("--unshare-all");
  if (shareNet) args.push("--share-net");
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
  return { argv: args, backend };
}

export function sandboxArgv(
  session: Pick<CodexSession, "cwd" | "writable">,
  workdir: string,
  command: string[],
): string[] | null {
  return sandboxPlan(session, workdir, command)?.argv ?? null;
}

export function stopSandboxPlan(plan: SandboxPlan | null): void {
  if (plan?.backend === "codex-windows") {
    if (!plan.watched && plan.cleanupRoot) cleanupCodexWindowsSandboxPath(plan.cleanupRoot);
    return;
  }
  if (plan?.backend !== "docker" || !plan.containerName) return;
  const executable = dockerPath();
  if (executable) stopDockerContainer(executable, plan.containerName);
  liveDockerContainers.delete(plan.containerName);
}

export function watchSandboxProcess(plan: SandboxPlan | null, exited: Promise<number>): void {
  if (plan?.backend === "codex-windows" && plan.cleanupRoot) {
    plan.watched = true;
    void exited.then(
      () => cleanupCodexWindowsSandboxPath(plan.cleanupRoot!),
      () => cleanupCodexWindowsSandboxPath(plan.cleanupRoot!),
    );
    return;
  }
  if (plan?.backend !== "docker" || !plan.containerName) return;
  const executable = dockerPath();
  if (!executable) return;
  void exited.then(() => reapDockerContainer(plan.containerName!, executable), () => reapDockerContainer(plan.containerName!, executable));
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
