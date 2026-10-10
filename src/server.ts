// server.ts — servidor loopback estilo Responses para Codex.
//
// M2: rutas nativas reenviadas al backend de Codex.
// M3: /v1/models clonado con filas Web.
// M7: si el POST /v1/responses pide un modelo chatgpt-web/*, la llamada va al
// browser persistente (src/web-turn.ts) en vez de al upstream nativo. Ese es
// el punto donde Codex deja de hablar con Electron y habla con este CLI.
import { ResponsesInputError } from "./responses/input";
import { loadConfig, type AppConfig } from "./config";
import { filterHeaders, forwardNative, type NativeEndpoint, upstreamUrl } from "./passthrough";
import { augmentCatalog, openAiWebModelList } from "./web-models";
import { handleWebResponses, peekWebRequest } from "./web-responses";
import { handleChatCompletions } from "./chat-completions";
import { runIdempotent } from "./turn-idempotency";
import { parseWsTurn, wsFrames } from "./ws-responses";
import { guardLocalRequest } from "./local-guard";
import { forwardHeaders, NativeWsProxy, upstreamWsUrl } from "./ws-native-proxy";
import { ChatTurnError, chatStatus, runChatTurn } from "./chat-turn";
import { publicChat } from "./chats";
import { finishSettingsWindow, openSettingsWindow, settingsStatus, verifySettings } from "./chatgpt-settings";
import { formatPrometheusMetrics, getMetrics } from "./metrics";

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
    const denied = guardLocalRequest(req, { requireJsonBody: true, requireToken: true });
    if (denied) return denied;
    const url = new URL(req.url);
    if (url.pathname === "/v1/responses" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return new Response("websocket upgrade lo resuelve Bun.serve", { status: 426 });
    }
    if (url.pathname === "/metrics" && req.method === "GET") {
      return new Response(formatPrometheusMetrics(), {
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    if ((url.pathname === "/api/metrics" || url.pathname === "/isymcp/metrics") && req.method === "GET") {
      return Response.json(getMetrics());
    }
    if ((url.pathname === "/api/health" || url.pathname === "/health") && req.method === "GET") {
      const m = getMetrics();
      return Response.json({
        status: "ok",
        uptime_seconds: m.uptimeSeconds,
        upstream: config.upstreamBase,
        web_models: config.webModels,
        memory: m.memory,
        turns: m.turns,
      });
    }
    // Chat para TUIs tipo opencode (@ai-sdk/openai-compatible habla
    // /chat/completions, no Responses). Solo modelos Web; lo demas 400.
    if (url.pathname === "/v1/chat/completions") {
      if (req.method !== "POST") {
        return errorJson(405, "method_not_allowed", "POST esperado para /v1/chat/completions");
      }
      const turnId = req.headers.get("x-isymcp-turn-id")?.trim() || null;
      return runIdempotent(turnId, () => handleChatCompletions(req, config));
    }
    // Chat local del panel (isymcp panel). Rutas propias: el contrato
    // OpenAI-compatible de /v1/* no cambia. El panel es el unico cliente
    // previsto; la guarda Host/Origin/JSON de arriba aplica igual.
    if (url.pathname === "/isymcp/chat/status" && req.method === "GET") {
      return Response.json(chatStatus());
    }
    // "Sincronizar ajustes": ventana visible de Chrome para configurar ChatGPT a mano.
    if (url.pathname === "/isymcp/settings" && req.method === "GET") return Response.json(settingsStatus());
    if (url.pathname === "/isymcp/settings/open" && req.method === "POST") {
      const r = openSettingsWindow(config);
      return Response.json({ ...r, ...settingsStatus() }, { status: r.started ? 202 : 409 });
    }
    if (url.pathname === "/isymcp/settings/finish" && req.method === "POST") {
      return Response.json({ finished: finishSettingsWindow(), ...settingsStatus() });
    }
    if (url.pathname === "/isymcp/settings/verify" && req.method === "POST") {
      try {
        return Response.json({ seen: await verifySettings(config), ...settingsStatus() });
      } catch (error) {
        return errorJson(502, "settings_verify_failed", error instanceof Error ? error.message : String(error));
      }
    }
    if (url.pathname === "/isymcp/chat/turn") {
      if (req.method !== "POST") return errorJson(405, "method_not_allowed", "POST esperado");
      const body = (await req.json().catch(() => null)) as { chat_id?: unknown; message?: unknown } | null;
      if (!body || typeof body.chat_id !== "string" || typeof body.message !== "string") {
        return errorJson(400, "chat_bad_request", "se espera {chat_id, message}");
      }
      try {
        const outcome = await runChatTurn(body.chat_id, body.message, config);
        return Response.json({ ok: outcome.ok, reply: outcome.reply, chat: publicChat(outcome.chat, false) });
      } catch (error) {
        if (error instanceof ChatTurnError) return errorJson(error.status, error.type, error.message);
        return errorJson(500, "chat_internal", error instanceof Error ? error.message : String(error));
      }
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
      try {
        const web = await peekWebRequest(req);
        if (web) return handleWebResponses(req, config, web);
      } catch (error) {
        if (error instanceof ResponsesInputError) return errorJson(error.status, error.type, error.message);
        throw error;
      }
    }
    if (route.endpoint === "responses/compact") {
      const body = await req.clone().json().catch(() => null);
      if (typeof body?.model === "string" && body.model.startsWith("chatgpt-web/"))
        return errorJson(400, "web_compaction_unsupported", "Web task history cannot be compacted in this delivery");
    }
    return forwardNative(req, route.endpoint, config);
  };
}

export function startServer(config: AppConfig = loadConfig(), options: { webResponse?: typeof handleWebResponses } = {}) {
  const webResponse = options.webResponse ?? handleWebResponses;
  const handler = createHandler(config);
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch(req, bun) {
      const url = new URL(req.url);
      // Codex abre ws://…/v1/responses con GET. Si eso cae al chequeo de POST,
      // devolvemos 405 y Codex reintenta contra la cuenta, que rechaza el slug.
      if (url.pathname === "/v1/responses" && (req.method === "GET" || req.headers.get("upgrade"))) {
        // Los websockets no tienen CORS: sin esta guarda cualquier pagina
        // abierta podria hablar con el bridge (CSWSH).
        const denied = guardLocalRequest(req, { requireToken: true });
        if (denied) return denied;
        if (bun.upgrade(req, { data: { headers: Object.fromEntries(req.headers), native: null as NativeWsProxy | null } })) return undefined;
        return new Response("websocket requerido", { status: 426 });
      }
      return handler(req);
    },
    websocket: {
      close(ws) {
        ws.data.native?.close();
      },
      async message(ws, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        let turn;
        try {
          turn = parseWsTurn(raw);
        } catch (error) {
          if (!(error instanceof ResponsesInputError)) throw error;
          ws.send(JSON.stringify({ type: "error", error: { type: error.type, message: error.message } }));
          return;
        }
        if (!turn?.web) {
          // Nativo (o un evento sin modelo de una conexion ya nativa): se
          // reenvia tal cual al upstream de Codex con la auth de la app.
          if (!turn && !ws.data.native?.active) {
            ws.send(JSON.stringify({ type: "error", error: { type: "ws_bad_request", message: "mensaje sin modelo" } }));
            return;
          }
          ws.data.native ??= new NativeWsProxy(ws, upstreamWsUrl(config.upstreamBase), forwardHeaders(ws.data.headers));
          ws.data.native.send(message);
          return;
        }
        try {
          const headers = new Headers(ws.data.headers);
          headers.delete("upgrade"); headers.delete("connection");
          headers.set("content-type", "application/json");
          const request = new Request("http://127.0.0.1/v1/responses", { method: "POST", headers,
            body: JSON.stringify({ ...turn.body, stream: false }) });
          const response = await webResponse(request, config, { ...turn, stream: false });
          const body = await response.json();
          if (!response.ok) { ws.send(JSON.stringify({ type: "error", error: body.error })); return; }
          for (const frame of wsFrames(turn.model, body.output_text, body)) ws.send(frame);
        } catch {
          ws.send(JSON.stringify({ type: "error", error: { type: "web_task_state_unavailable", message: "Web task request could not be completed" } }));
        }
      },
    },
  });
  return server;
}
