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
}

/**
 * Devuelve una respuesta 403 si la request no viene de un cliente local
 * legitimo; null si puede seguir.
 */
export function guardLocalRequest(req: Request, options: GuardOptions = {}): Response | null {
  const allowed = allowedHosts();
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
