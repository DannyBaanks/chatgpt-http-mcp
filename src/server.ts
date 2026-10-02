// server.ts — servidor loopback estilo Responses para Codex.
//
// M2: rutas nativas reenviadas al backend de Codex. Las rutas Web
// (catalogo clonado / transporte HTTP) llegan en M3/M4.
import { loadConfig, type AppConfig } from "./config";
import { forwardNative, type NativeEndpoint } from "./passthrough";

type Route = { method: "GET" | "POST"; endpoint: NativeEndpoint };

const ROUTES: Record<string, Route> = {
  "/v1/models": { method: "GET", endpoint: "models" },
  "/v1/responses": { method: "POST", endpoint: "responses" },
  "/v1/responses/compact": { method: "POST", endpoint: "responses/compact" },
};

function errorJson(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

export function createHandler(config: AppConfig): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", upstream: config.upstreamBase });
    }
    const route = ROUTES[url.pathname];
    if (!route) {
      return errorJson(404, "not_found", `ruta desconocida: ${url.pathname}`);
    }
    if (req.method !== route.method) {
      return errorJson(405, "method_not_allowed", `${route.method} esperado para ${url.pathname}`);
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
