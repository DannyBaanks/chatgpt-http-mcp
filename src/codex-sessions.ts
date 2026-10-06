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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface CodexSession {
  token: string;
  fp: string;
  label: string;
  cwd: string;
  writable: boolean;
  createdAt: string;
}

interface Registry {
  schema: string;
  sessions: CodexSession[];
}

const SCHEMA = "codex-web-http.codex-sessions/1";

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
  options: { label?: string; writable?: boolean } = {},
): CodexSession {
  if (!cwd || !isAbsolute(cwd)) throw new Error(`cwd debe ser una ruta absoluta: ${cwd || "(vacio)"}`);
  const abs = resolve(cwd);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`cwd no existe o no es un directorio: ${abs}`);
  }
  const token = randomBytes(32).toString("base64url");
  const session: CodexSession = {
    token,
    fp: fingerprint(token),
    label: options.label?.trim() || `session-${new Date().toISOString().slice(0, 19)}`,
    cwd: abs,
    writable: options.writable === true,
    createdAt: new Date().toISOString(),
  };
  const reg = readRegistry();
  reg.sessions.push(session);
  writeRegistry(reg);
  return session;
}

export function readSessions(): CodexSession[] {
  return readRegistry().sessions;
}

export function revokeSession(prefixOrFp: string): number {
  if (!prefixOrFp.trim()) throw new Error("revoke requiere un token o su fingerprint");
  const reg = readRegistry();
  const before = reg.sessions.length;
  reg.sessions = reg.sessions.filter(
    (s) => !s.token.startsWith(prefixOrFp) && !s.fp.startsWith(prefixOrFp),
  );
  const removed = before - reg.sessions.length;
  if (removed > 0) writeRegistry(reg);
  return removed;
}

export function findSessionByToken(token: string): CodexSession | null {
  if (!token) return null;
  for (const session of readRegistry().sessions) {
    const a = Buffer.from(session.token);
    const b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) return session;
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

export const BWRAP = "/usr/bin/bwrap";

export function sandboxAvailable(): boolean {
  return existsSync(BWRAP);
}

/**
 * argv de bwrap para una sesion. Read-only: root como solo-lectura.
 * Writable: ademas bindea el workspace (escrituras solo ahi). /tmp siempre tmpfs.
 * Devuelve null si no hay sandbox y la sesion es read-only (fail closed).
 */
export function sandboxArgv(
  session: Pick<CodexSession, "cwd" | "writable">,
  workdir: string,
  command: string[],
): string[] | null {
  if (!sandboxAvailable()) {
    if (!session.writable) return null;
    return [...command];
  }
  const args = [
    BWRAP,
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--die-with-parent",
    "--chdir", workdir,
  ];
  // Re-exponer el workspace DESPUES de --tmpfs /tmp: si el workspace vive bajo
  // /tmp (tests, temporales) el tmpfs lo taparia y --chdir fallaria.
  if (session.writable) {
    args.push("--bind", session.cwd, session.cwd);
  } else {
    args.push("--ro-bind", session.cwd, session.cwd);
  }
  args.push("--", ...command);
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
