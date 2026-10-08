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
// Los clientes legitimos (Codex, opencode, curl) no mandan Origin y si
// mandan JSON, asi que no les cambia nada.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
  /** Exigir el token del bridge (CODEX_WEB_HTTP_TOKEN) si esta definido. */
  requireToken?: boolean;
}

/** Cabecera con el token del bridge (no usa Authorization: esa viaja al upstream). */
export const TOKEN_HEADER = "x-isymcp-token";

export function bridgeToken(env: Record<string, string | undefined> = process.env): string | null {
  const t = env.CODEX_WEB_HTTP_TOKEN?.trim();
  return t ? t : null;
}

/** Cabeceras para que un cliente interno (panel, canario, MCP) hable con el bridge. */
export function bridgeAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = bridgeToken();
  return t ? { ...extra, [TOKEN_HEADER]: t } : extra;
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
 * Un host no loopback (bind o ALLOWED_HOSTS) sin token dejaria la sesion de
 * ChatGPT abierta a quien llegue al puerto: se niega a arrancar.
 */
export function assertSafeExposure(hostname: string, env: Record<string, string | undefined> = process.env): void {
  const extra = (env.CODEX_WEB_HTTP_ALLOWED_HOSTS ?? "").split(",").some((h) => h.trim());
  const bindsLoopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname.trim().toLowerCase());
  if ((extra || !bindsLoopback) && !bridgeToken(env)) {
    throw new Error(
      "exposicion no loopback (CODEX_WEB_HTTP_HOST/CODEX_WEB_HTTP_ALLOWED_HOSTS) requiere CODEX_WEB_HTTP_TOKEN",
    );
  }
}

/**
 * Devuelve una respuesta 403 si la request no viene de un cliente local
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
  const token = options.requireToken ? bridgeToken() : null;
  if (token && !tokenMatches(req.headers.get(TOKEN_HEADER), token)) {
    return Response.json(
      { error: { type: "unauthorized", message: `falta o es invalido ${TOKEN_HEADER} (CODEX_WEB_HTTP_TOKEN)` } },
      { status: 401 },
    );
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
