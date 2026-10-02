// server.ts — servidor loopback estilo Responses para Codex.
//
// M2: rutas nativas reenviadas al backend de Codex. Las rutas Web
// (catalogo clonado / transporte HTTP) llegan en M3/M4.
import { loadConfig, type AppConfig } from "./config";
import { filterHeaders, forwardNative, type NativeEndpoint, upstreamUrl } from "./passthrough";
import { augmentCatalog } from "./web-models";

type Route = { method: "GET" | "POST"; endpoint: NativeEndpoint };

const ROUTES: Record<string, Route> = {
  "/v1/models": { method: "GET", endpoint: "models" },
  "/v1/responses": { method: "POST", endpoint: "responses" },
  "/v1/responses/compact": { method: "POST", endpoint: "responses/compact" },
};

function errorJson(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

/**
 * Modelos con filas Web clonadas: trae el catalogo nativo con la auth del
 * llamador, lo aumenta y responde JSON. Si el upstream falla, no se inventa
 * catalogo: se propaga el error.
 */
async function modelsWithWeb(req: Request, config: AppConfig): Promise<Response> {
  const url = new URL(req.url);
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(config, "models", url.search), {
      method: "GET",
      headers: filterHeaders(req.headers),
      redirect: "manual",
    });
  } catch (error) {
    return errorJson(502, "upstream_unreachable", error instanceof Error ? error.message : String(error));
  }
  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: filterHeaders(upstream.headers),
    });
  }
  try {
    const native = await upstream.json();
    return Response.json(augmentCatalog(native, config.capabilities));
  } catch (error) {
    return errorJson(
      502,
      "catalog_augment_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function createHandler(config: AppConfig): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        upstream: config.upstreamBase,
        web_models: config.webModels,
      });
    }
    const route = ROUTES[url.pathname];
    if (!route) {
      return errorJson(404, "not_found", `ruta desconocida: ${url.pathname}`);
    }
    if (req.method !== route.method) {
      return errorJson(405, "method_not_allowed", `${route.method} esperado para ${url.pathname}`);
    }
    if (route.endpoint === "models" && config.webModels === "on") {
      return modelsWithWeb(req, config);
    }
    return forwardNative(req, route.endpoint, config);
  };
}

export function startServer(config: AppConfig = loadConfig()) {
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch: createHandler(config),
  });
  return server;
}
