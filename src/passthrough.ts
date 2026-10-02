// passthrough.ts — reenvio HTTP nativo hacia chatgpt.com/backend-api/codex.
//
// M2: transporte sin navegador. Se reenvian metodo, cabeceras (menos
// hop-by-hop) y body; se devuelve status/body/stream del upstream tal cual.
// No se leen ni escriben credenciales: el llamador (Codex) trae su auth.
import type { AppConfig } from "./config";

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

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(config, endpoint, url.search), {
      method,
      headers,
      body,
      redirect: "manual",
    });
  } catch (error) {
    return Response.json(
      {
        error: {
          type: "upstream_unreachable",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: filterHeaders(upstream.headers),
  });
}
