// local-guard.ts — escuchar en 127.0.0.1 no basta para que solo hable lo local.
//
// Cualquier pagina web abierta en el navegador puede:
//   - hacer POST a http://127.0.0.1:<puerto> con un body text/plain (peticion
//     "simple": sin preflight CORS) -> CSRF; Bun parsea el JSON igual;
//   - resolver su propio dominio a 127.0.0.1 (DNS rebinding) y LEER las
//     respuestas, porque para el navegador es su mismo origen;
//   - abrir un websocket a 127.0.0.1 (los websockets no tienen CORS).
//
// Regla: Host debe ser loopback (o estar en CODEX_WEB_HTTP_ALLOWED_HOSTS),
// Origin, si viene, tambien; y los POST deben declarar application/json.
// Ademas el token es SIEMPRE obligatorio: se toma de CODEX_WEB_HTTP_TOKEN si
// esta definido y, si no, del archivo 0600 <bridge home>/token, que se crea en
// el primer arranque. Los clientes legitimos (panel, MCP, canario, Codex, CLI)
// lo mandan ellos mismos, asi que el usuario no configura nada.

import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { bridgeHome } from "./codex-sessions";
import { ensurePrivatePath, securePrivatePath } from "./platform/private-path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,256}$/;

function allowedHosts(): Set<string> {
  const extra = (process.env.CODEX_WEB_HTTP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...LOOPBACK_HOSTS, ...extra]);
}

function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function forbidden(type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status: 403 });
}

export interface GuardOptions {
  /** POST con body: exigir content-type application/json. */
  requireJsonBody?: boolean;
  /**
   * Solo loopback: ignora CODEX_WEB_HTTP_ALLOWED_HOSTS. Para superficies que
   * disparan acciones locales (panel) y no deben alcanzarse por un tunel.
   */
  loopbackOnly?: boolean;
  /**
   * Exigir el token del bridge. Activo salvo que el arranque lo desactive
   * explicitamente (solo pruebas de enrutado).
   */
  requireToken?: boolean;
}

/** Cabecera con el token del bridge (no usa Authorization: esa viaja al upstream). */
export const TOKEN_HEADER = "x-isymcp-token";

/** Ruta del token persistido (0600) dentro del home del bridge. */
export function bridgeTokenPath(env: Record<string, string | undefined> = process.env): string {
  return join(bridgeHome(env), "token");
}

function ensurePrivateDirectory(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`el directorio del bridge no es un directorio real: ${dir}`);
  }
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid?.()) throw new Error(`el directorio del bridge no pertenece al usuario: ${dir}`);
    if ((stat.mode & 0o777) !== 0o700) securePrivatePath(dir, true, 0o700);
  } else {
    securePrivatePath(dir, true);
  }
}

function readPrivateToken(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`el token del bridge no es un archivo real: ${path}`);
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid?.()) throw new Error(`el token del bridge no pertenece al usuario: ${path}`);
    if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o600);
  }
  const token = readFileSync(path, "utf8").trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`token del bridge invalido en ${path}; borra ese archivo para regenerarlo`);
  }
  return token;
}

function mintPrivateToken(path: string): string {
  const token = randomBytes(32).toString("base64url");
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readPrivateToken(path);
    throw new Error(`no se pudo crear el token del bridge en ${path}: ${(error as Error).message}`);
  }
  try {
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  securePrivatePath(path, false, 0o600);
  ensurePrivatePath(path, false);
  return token;
}

// Evita releer (y re-ACL en Windows) en cada request; el token es estable.
const tokenCache = new Map<string, string>();

/**
 * Token del bridge: CODEX_WEB_HTTP_TOKEN si esta definido; si no, se lee (o se
 * crea con permisos 0600) <bridge home>/token. Lanza un error accionable si el
 * archivo no se puede preparar o su contenido no es valido: el guard falla
 * cerrado.
 */
export function bridgeToken(env: Record<string, string | undefined> = process.env): string {
  const override = env.CODEX_WEB_HTTP_TOKEN?.trim();
  if (override) return override;
  const home = bridgeHome(env);
  const cached = tokenCache.get(home);
  if (cached) return cached;
  ensurePrivateDirectory(home);
  const path = join(home, "token");
  const token = existsSync(path) ? readPrivateToken(path) : mintPrivateToken(path);
  tokenCache.set(home, token);
  return token;
}

/** Cabeceras para que un cliente interno (panel, canario, MCP) hable con el bridge. */
export function bridgeAuthHeaders(
  extra: Record<string, string> = {},
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return { ...extra, [TOKEN_HEADER]: bridgeToken(env) };
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]!;
  return diff === 0;
}

/**
 * Prepara el token antes de arrancar. Cualquier exposicion (tambien loopback)
 * queda autenticada; si el token no se puede crear o leer, se niega a arrancar
 * en vez de quedar abierto.
 */
export function assertSafeExposure(_hostname: string, env: Record<string, string | undefined> = process.env): void {
  try {
    bridgeToken(env);
  } catch (error) {
    throw new Error(
      `no se pudo preparar el token del bridge (CODEX_WEB_HTTP_TOKEN o archivo 0600): ${(error as Error).message}`,
    );
  }
}

/**
 * Devuelve una respuesta 403/401/503 si la request no viene de un cliente local
 * legitimo; null si puede seguir.
 */
export function guardLocalRequest(req: Request, options: GuardOptions = {}): Response | null {
  const allowed = options.loopbackOnly ? LOOPBACK_HOSTS : allowedHosts();
  const hostHeader = req.headers.get("host") ?? new URL(req.url).host;
  const host = hostnameOf(hostHeader);
  if (!host || !allowed.has(host)) {
    return forbidden("forbidden_host", `Host no permitido: ${hostHeader} (solo loopback; ver CODEX_WEB_HTTP_ALLOWED_HOSTS)`);
  }
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = origin === "null" ? null : new URL(origin).hostname.toLowerCase();
    } catch {
      originHost = null;
    }
    if (!originHost || !allowed.has(originHost)) {
      return forbidden("forbidden_origin", `Origin no permitido: ${origin}`);
    }
  }
  if (options.requireToken) {
    let expected: string;
    try {
      expected = bridgeToken();
    } catch (error) {
      return Response.json(
        { error: { type: "bridge_token_unavailable", message: (error as Error).message } },
        { status: 503 },
      );
    }
    if (!tokenMatches(req.headers.get(TOKEN_HEADER), expected)) {
      return Response.json(
        { error: { type: "unauthorized", message: `falta o es invalido ${TOKEN_HEADER} (CODEX_WEB_HTTP_TOKEN)` } },
        { status: 401 },
      );
    }
  }
  if (options.requireJsonBody && req.method === "POST") {
    const type = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!type.startsWith("application/json")) {
      return Response.json(
        { error: { type: "unsupported_media_type", message: "POST requiere content-type: application/json" } },
        { status: 415 },
      );
    }
  }
  return null;
}
