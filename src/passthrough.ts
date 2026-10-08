// passthrough.ts — reenvio HTTP nativo hacia chatgpt.com/backend-api/codex.
//
// M5: timeout de headers, propagacion de cancelacion del cliente y wrapper
// SSE tolerante a reset (ver responses/stream.ts). No se leen ni escriben
// credenciales: el llamador (Codex) trae su auth.
import type { AppConfig } from "./config";
import { errorJson } from "./responses/errors";
import { isEventStream, withUncleanCloseTolerance } from "./responses/stream";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // Bun fetch descomprime solo; reenviar accept-encoding rompe el passthrough.
  "accept-encoding",
  // Token del bridge: nunca debe llegar al upstream.
  "x-isymcp-token",
]);

export function filterHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of source) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out.append(name, value);
  }
  return out;
}

export type NativeEndpoint = "models" | "responses" | "responses/compact";

export function upstreamUrl(config: AppConfig, endpoint: NativeEndpoint, search: string): string {
  return `${config.upstreamBase}/${endpoint}${search}`;
}

/** Reenvia una request del cliente al backend nativo de Codex. */
export async function forwardNative(
  req: Request,
  endpoint: NativeEndpoint,
  config: AppConfig,
): Promise<Response> {
  const url = new URL(req.url);
  const method = endpoint === "models" ? "GET" : "POST";
  const headers = filterHeaders(req.headers);

  let body: ArrayBuffer | undefined;
  if (method === "POST") {
    body = await req.arrayBuffer();
  }

  // Timeout solo de la fase de headers: una vez que el upstream responde,
  // el stream puede durar lo que dure el turno. La cancelacion del cliente
  // se propaga durante toda la vida del request.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const onClientAbort = () => controller.abort();
  if (req.signal.aborted) controller.abort();
  else req.signal.addEventListener("abort", onClientAbort, { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(config, endpoint, url.search), {
      method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      return errorJson(504, "upstream_timeout", `el upstream no respondio headers en ${config.timeoutMs}ms`);
    }
    if (req.signal.aborted) {
      return errorJson(499, "client_cancelled", "el cliente cancelo la request");
    }
    return errorJson(
      502,
      "upstream_unreachable",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }

  const responseHeaders = filterHeaders(upstream.headers);
  const contentType = upstream.headers.get("content-type");
  const responseBody =
    upstream.body && isEventStream(contentType)
      ? withUncleanCloseTolerance(upstream.body)
      : upstream.body;

  return new Response(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
