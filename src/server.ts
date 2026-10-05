// server.ts — servidor loopback estilo Responses para Codex.
//
// M2: rutas nativas reenviadas al backend de Codex.
// M3: /v1/models clonado con filas Web.
// M7: si el POST /v1/responses pide un modelo chatgpt-web/*, la llamada va al
// browser persistente (src/web-turn.ts) en vez de al upstream nativo. Ese es
// el punto donde Codex deja de hablar con Electron y habla con este CLI.
import { loadConfig, type AppConfig } from "./config";
import { filterHeaders, forwardNative, type NativeEndpoint, upstreamUrl } from "./passthrough";
import { augmentCatalog, openAiWebModelList } from "./web-models";
import { handleWebResponses, peekWebRequest } from "./web-responses";
import { handleChatCompletions } from "./chat-completions";
import { parseWsTurn, toJsonl, wsFrames } from "./ws-responses";
import { sendWebTurn } from "./web-turn";
import { loadSession, rememberConversation } from "./sessions";

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
  // Las filas Web no necesitan el upstream: se sirven siempre en forma OpenAI
  // (data:[{id}]) para clientes como ISyCode/opencode, y ademas se aumentan las
  // nativas cuando el upstream responde. Sin upstream no se inventan nativas:
  // se devuelven solo las filas Web, que son las unicas que este server ejecuta.
  const localList = openAiWebModelList(config.capabilities);
  const localOnly = () => Response.json(localList, { headers: { "x-isyco-web-models": "local" } });
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(config, "models", url.search), {
      method: "GET",
      headers: filterHeaders(req.headers),
      redirect: "manual",
    });
  } catch {
    return localOnly();
  }
  if (!upstream.ok) {
    return localOnly();
  }
  try {
    const native = await upstream.json();
    return Response.json({ ...augmentCatalog(native, config.capabilities), data: localList.data });
  } catch {
    return localOnly();
  }
}

export function createHandler(config: AppConfig): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/responses" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return new Response("websocket upgrade lo resuelve Bun.serve", { status: 426 });
    }
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        upstream: config.upstreamBase,
        web_models: config.webModels,
      });
    }
    // Chat para TUIs tipo opencode (@ai-sdk/openai-compatible habla
    // /chat/completions, no Responses). Solo modelos Web; lo demas 400.
    if (url.pathname === "/v1/chat/completions") {
      if (req.method !== "POST") {
        return errorJson(405, "method_not_allowed", "POST esperado para /v1/chat/completions");
      }
      return handleChatCompletions(req, config);
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
    if (route.endpoint === "responses" && config.webModels === "on") {
      // peek sobre un clon: el request original sigue intacto para el
      // passthrough nativo cuando el modelo NO es Web.
      const web = await peekWebRequest(req);
      if (web) return handleWebResponses(req, config, web);
    }
    return forwardNative(req, route.endpoint, config);
  };
}

export function startServer(config: AppConfig = loadConfig()) {
  const handler = createHandler(config);
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch(req, bun) {
      const url = new URL(req.url);
      // Codex abre ws://…/v1/responses con GET. Si eso cae al chequeo de POST,
      // devolvemos 405 y Codex reintenta contra la cuenta, que rechaza el slug.
      if (url.pathname === "/v1/responses" && (req.method === "GET" || req.headers.get("upgrade"))) {
        if (bun.upgrade(req)) return undefined;
        return new Response("websocket requerido", { status: 426 });
      }
      return handler(req);
    },
    websocket: {
      async message(ws, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        const turn = parseWsTurn(raw);
        if (!turn?.web) {
          ws.send(JSON.stringify({ type: "error", error: { message: "solo modelos chatgpt-web/* por este websocket" } }));
          return;
        }
        const session = loadSession("default");
        try {
          const result = await sendWebTurn(turn.prompt, {
            statePath: session?.statePath ?? config.browserStatePath,
            conversationUrl: session?.conversationUrl ?? undefined,
            browser: config.browser,
            headed: config.browserHeaded,
            deadlineMs: config.webTurnDeadlineMs,
          });
          if (session) rememberConversation(session.name, result.url);
          if (!result.text) {
            ws.send(toJsonl([{ type: "error", error: { message: "la conexion web no devolvio texto" } }]));
            return;
          }
          ws.send(toJsonl(wsFrames(turn.model, result.text).map((line) => JSON.parse(line))));
        } catch (error) {
          ws.send(JSON.stringify({
            type: "error",
            error: { message: error instanceof Error ? error.message : String(error) },
          }));
        }
      },
    },
  });
  return server;
}
