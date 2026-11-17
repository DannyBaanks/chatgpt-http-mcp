// src/openisy-tunnel.ts — Túnel bidireccional hacia OpenISy / OpenCode (HTTP v2 Daemon) y despacho de sub-agentes multi-provider.
//
// Permite que cualquier agente conectado a isymcp-hub (AGY, Claude Code, Codex, ChatGPT, etc.):
//   1. Inspeccione sesiones y lea la conversación activa de una TUI de OpenISy en tiempo real.
//   2. Envíe mensajes como si fuera el usuario (prompt con steer/queue), como si fuera el propio
//      agente/sistema de la TUI (synthetic), o ejecute comandos internos.
//   3. Tome control de la sesión activa (cambiar modelo/provider, cambiar agente, aprobar permisos
//      bloqueados, responder formularios, interrumpir turnos o inyectar variables de entorno).
//   4. Despache sub-agentes con herramientas completas en OpenISy (colgados o no de la sesión TUI
//      principal vía parentID) usando los providers configurados (freellmapi, xkiro, nvidia, isyco-web)
//      o con API keys externas efímeras.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenIsyTarget = "openisy" | "opencode";

export interface OpenIsyServiceInfo {
  id?: string;
  version?: string;
  url: string;
  pid?: number;
  password?: string;
  target: OpenIsyTarget;
  sourcePath: string;
}

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

function stateDir(env: Record<string, string | undefined> = process.env): string {
  return env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
}

function configFileForTarget(target: OpenIsyTarget, env: Record<string, string | undefined> = process.env): string {
  const home = homedir();
  if (target === "openisy") {
    const dir = env.OPENISY_CONFIG_DIR?.trim() || join(home, ".openisy", "config");
    return join(dir, "opencode.json");
  }
  return join(home, ".config", "opencode", "opencode.json");
}

/**
 * Descubre el daemon HTTP v2 activo de OpenISy (`service-local.json`) u OpenCode (`service.json`).
 */
export function discoverOpenIsyService(
  opts: { target?: OpenIsyTarget; serverUrl?: string; password?: string; env?: Record<string, string | undefined> } = {},
): OpenIsyServiceInfo | null {
  const env = opts.env ?? process.env;
  const target: OpenIsyTarget = opts.target === "opencode" ? "opencode" : "openisy";
  if (opts.serverUrl) {
    return {
      url: opts.serverUrl.replace(/\/+$/, ""),
      password: opts.password,
      target,
      sourcePath: "explicit",
    };
  }
  const opencodeState = join(stateDir(env), "opencode");
  const candidates: Array<{ path: string; target: OpenIsyTarget }> =
    target === "openisy"
      ? [
          { path: join(opencodeState, "service-local.json"), target: "openisy" },
          { path: join(opencodeState, "service.json"), target: "opencode" },
        ]
      : [
          { path: join(opencodeState, "service.json"), target: "opencode" },
          { path: join(opencodeState, "service-local.json"), target: "openisy" },
        ];

  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    try {
      const data = JSON.parse(readFileSync(c.path, "utf8")) as Record<string, unknown>;
      if (typeof data.url === "string" && data.url.startsWith("http")) {
        return {
          id: typeof data.id === "string" ? data.id : undefined,
          version: typeof data.version === "string" ? data.version : undefined,
          url: data.url.replace(/\/+$/, ""),
          pid: typeof data.pid === "number" ? data.pid : undefined,
          password: opts.password ?? (typeof data.password === "string" ? data.password : undefined),
          target: c.target,
          sourcePath: c.path,
        };
      }
    } catch {
      /* archivo inválido: probar siguiente */
    }
  }
  return null;
}

/** Arranca el servicio de fondo si no estaba activo y devuelve su descriptor. */
export function ensureOpenIsyService(
  opts: { target?: OpenIsyTarget; serverUrl?: string; password?: string; autoStart?: boolean } = {},
): OpenIsyServiceInfo {
  const found = discoverOpenIsyService(opts);
  if (found) return found;
  if (opts.autoStart !== false) {
    const bin = opts.target === "opencode"
      ? (Bun.which("opencode") ?? join(homedir(), ".opencode", "bin", "opencode"))
      : (Bun.which("openisy") ?? join(homedir(), ".opencode", "bin", "openisy"));
    if (existsSync(bin)) {
      Bun.spawnSync([bin, "service", "start"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      const started = discoverOpenIsyService(opts);
      if (started) return started;
    }
  }
  throw new Error(
    `No se encontró el daemon HTTP de ${opts.target ?? "openisy"} en ${join(stateDir(), "opencode")}. Ejecuta 'openisy service start'.`,
  );
}

function buildAuthHeaders(service: OpenIsyServiceInfo, extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  if (service.password) {
    const token = Buffer.from(`opencode:${service.password}`).toString("base64");
    headers.set("authorization", `Basic ${token}`);
  }
  return headers;
}

export async function openIsyRequest<T = any>(
  service: OpenIsyServiceInfo,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  opts: {
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: boolean; status: number; data: T; error?: string }> {
  const url = new URL(path, service.url);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers = buildAuthHeaders(service);
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(opts.body);
  }
  const timeoutMs = opts.timeoutMs ?? 60_000;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const detail = typeof parsed === "object" && parsed !== null
        ? JSON.stringify(parsed).slice(0, 400)
        : String(parsed ?? res.statusText).slice(0, 400);
      return { ok: false, status: res.status, data: parsed as T, error: `HTTP ${res.status}: ${detail}` };
    }
    return { ok: true, status: res.status, data: parsed as T };
  } catch (e) {
    return { ok: false, status: 0, data: null as unknown as T, error: (e as Error).message };
  }
}

/**
 * Convierte `"providerID/modelID#variant"` o `{ providerID, id, variant }` en un `ModelRef` válido de OpenISy.
 */
export function parseModelRef(
  rawModel: unknown,
  explicitProvider?: string,
  explicitVariant?: string,
): ModelRef | undefined {
  if (!rawModel && !explicitProvider) return undefined;
  if (typeof rawModel === "object" && rawModel !== null) {
    const m = rawModel as Record<string, unknown>;
    const providerID = String(m.providerID ?? m.provider ?? explicitProvider ?? "").trim();
    const id = String(m.id ?? m.model ?? "").trim();
    const variant = typeof m.variant === "string" ? m.variant : explicitVariant;
    if (!providerID || !id) return undefined;
    return { providerID, id, ...(variant ? { variant } : {}) };
  }
  const str = String(rawModel ?? "").trim();
  if (!str) return undefined;
  const [beforeHash, hashVariant] = str.split("#", 2);
  const variant = explicitVariant || hashVariant || undefined;
  if (explicitProvider) {
    return { providerID: explicitProvider.trim(), id: beforeHash!, ...(variant ? { variant } : {}) };
  }
  const slashIdx = beforeHash!.indexOf("/");
  if (slashIdx <= 0) {
    throw new Error(`El modelo '${str}' debe incluir el provider (ej. 'xkiro/x-ai/grok-4.5' o pasar 'provider' por separado).`);
  }
  const providerID = beforeHash!.slice(0, slashIdx).trim();
  const id = beforeHash!.slice(slashIdx + 1).trim();
  return { providerID, id, ...(variant ? { variant } : {}) };
}

/**
 * Resuelve el `sessionID`: acepta un ID explícito (`ses_...`) o `"active"` / `"latest"` (por defecto)
 * para apuntar automáticamente a la TUI de OpenISy que Danny tiene abierta.
 */
export async function resolveSessionId(
  service: OpenIsyServiceInfo,
  sessionIdArg?: string,
  directory?: string,
): Promise<string> {
  const clean = String(sessionIdArg ?? "").trim();
  if (clean && clean !== "active" && clean !== "latest" && clean !== "auto") {
    return clean;
  }
  // 1. Si se pide específicamente una sesión corriendo ahora mismo:
  if (!clean || clean === "active" || clean === "auto") {
    const active = await openIsyRequest<{ data?: Record<string, { type: string }> }>(service, "GET", "/api/session/active");
    const activeIds = Object.keys(active.data?.data ?? {});
    if (activeIds.length > 0) return activeIds[0]!;
  }
  // 2. La sesión raíz más reciente (filtrada por directorio si se indica):
  const list = await openIsyRequest<{ data?: Array<{ id: string; parentID?: string }> }>(service, "GET", "/api/session", {
    query: { limit: 10, parentID: "null", ...(directory ? { directory } : {}) },
  });
  const first = list.data?.data?.[0]?.id;
  if (first) return first;
  // 3. Cualquier sesión sin filtro de directorio:
  const fallbackList = await openIsyRequest<{ data?: Array<{ id: string }> }>(service, "GET", "/api/session", {
    query: { limit: 5 },
  });
  const anySession = fallbackList.data?.data?.[0]?.id;
  if (anySession) return anySession;
  throw new Error("No se encontró ninguna sesión en OpenISy. Pasa session_id explícito o crea una nueva.");
}

/** Resume los providers configurados en opencode.json sin exponer secretos/API keys. */
export function summarizeConfiguredProviders(target: OpenIsyTarget = "openisy"): Array<{
  provider: string;
  name?: string;
  base_url?: string;
  models_count: number;
  sample_models: string[];
}> {
  const cfgPath = configFileForTarget(target);
  if (!existsSync(cfgPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, any>;
    const providersObj = parsed.providers ?? parsed.provider ?? {};
    return Object.entries(providersObj).map(([id, val]: [string, any]) => {
      const modelsObj = (val && typeof val === "object" && val.models) ? val.models : {};
      const modelIds = Object.keys(modelsObj);
      return {
        provider: id,
        name: typeof val?.name === "string" ? val.name : undefined,
        base_url: typeof val?.options?.baseURL === "string" ? val.options.baseURL : undefined,
        models_count: modelIds.length,
        sample_models: modelIds.slice(0, 8),
      };
    });
  } catch {
    return [];
  }
}

/** Simplifica los mensajes devueltos por `/api/session/{id}/message` para lectura rápida de un agente. */
export function summarizeMessages(rawMessages: any[]): Array<Record<string, unknown>> {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages.map((m) => {
    const contentArr = Array.isArray(m?.content) ? m.content : [];
    const textParts = contentArr.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text);
    const reasoningParts = contentArr.filter((c: any) => c?.type === "reasoning" && typeof c.text === "string").map((c: any) => c.text);
    const toolCalls = contentArr
      .filter((c: any) => c?.type === "tool-call" || c?.type === "tool_use" || c?.type === "tool")
      .map((c: any) => c?.name ?? c?.toolName ?? c?.id ?? "tool");
    return {
      id: m?.id,
      type: m?.type,
      ...(m?.agent ? { agent: m.agent } : {}),
      ...(m?.model ? { model: m.model } : {}),
      ...(m?.outcome ? { outcome: m.outcome } : {}),
      ...(m?.error ? { error: m.error } : {}),
      ...(textParts.length > 0 ? { text: textParts.join("\n\n") } : typeof m?.text === "string" ? { text: m.text } : {}),
      ...(reasoningParts.length > 0 ? { reasoning: reasoningParts.join("\n\n").slice(0, 1500) } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      created_at: m?.time?.created,
    };
  });
}

// ─── 1. openisy.sessions: estado del daemon, sesiones activas, agentes y providers ───

export async function listOpenIsyOverview(args: Record<string, any> = {}) {
  const service = ensureOpenIsyService({
    target: args.target,
    serverUrl: args.server_url,
    password: args.password,
  });
  const limit = Number(args.limit ?? 10);
  const [infoRes, activeRes, sessionsRes, agentsRes, modelsRes] = await Promise.all([
    openIsyRequest(service, "GET", "/api/info"),
    openIsyRequest<{ data?: Record<string, unknown> }>(service, "GET", "/api/session/active"),
    openIsyRequest<{ data?: any[] }>(service, "GET", "/api/session", {
      query: {
        limit,
        directory: args.directory ? String(args.directory) : undefined,
        parentID: args.parent_id !== undefined ? String(args.parent_id) : undefined,
        search: args.search ? String(args.search) : undefined,
      },
    }),
    openIsyRequest<{ data?: any[] }>(service, "GET", "/api/agent"),
    openIsyRequest<{ data?: any[] }>(service, "GET", "/api/model"),
  ]);

  const activeMap = activeRes.data?.data ?? {};
  const sessions = (sessionsRes.data?.data ?? []).map((s: any) => ({
    id: s.id,
    parent_id: s.parentID ?? null,
    title: s.title,
    agent: s.agent,
    model: s.model,
    outcome: s.outcome,
    running: Boolean(activeMap[s.id]),
    directory: s.location?.directory,
    updated_at: s.time?.updated,
  }));

  const agents = (agentsRes.data?.data ?? [])
    .filter((a: any) => !a.hidden)
    .map((a: any) => ({ id: a.id, name: a.name, mode: a.mode, description: String(a.description ?? "").slice(0, 140) }));

  const liveByProvider: Record<string, string[]> = {};
  for (const m of modelsRes.data?.data ?? []) {
    if (m?.providerID && m?.id) {
      (liveByProvider[m.providerID] ??= []).push(`${m.providerID}/${m.id}`);
    }
  }
  const liveProviders = Object.entries(liveByProvider).map(([provider, models]) => ({
    provider,
    models_count: models.length,
    sample_models: models.slice(0, 12),
  }));

  return {
    service: {
      target: service.target,
      url: service.url,
      pid: service.pid,
      version: infoRes.data?.version ?? service.version,
    },
    active_sessions: activeMap,
    sessions,
    agents,
    live_providers: liveProviders.length > 0 ? liveProviders : summarizeConfiguredProviders(service.target),
    configured_providers: summarizeConfiguredProviders(service.target),
  };
}

// ─── 2. openisy.messages: leer conversación, permisos pendientes y buzón de una TUI ──

export async function readOpenIsySession(args: Record<string, any> = {}) {
  const service = ensureOpenIsyService({
    target: args.target,
    serverUrl: args.server_url,
    password: args.password,
  });
  const sessionId = await resolveSessionId(service, args.session_id, args.directory);
  const limit = Number(args.limit ?? 10);

  const [sessionRes, msgRes, permRes, formRes, inboxRes, activeRes] = await Promise.all([
    openIsyRequest(service, "GET", `/api/session/${encodeURIComponent(sessionId)}`),
    openIsyRequest<{ data?: any[] }>(service, "GET", `/api/session/${encodeURIComponent(sessionId)}/message`, {
      query: { limit, order: "desc", ...(args.type ? { type: String(args.type) } : {}) },
    }),
    openIsyRequest<{ data?: any[] }>(service, "GET", `/api/session/${encodeURIComponent(sessionId)}/permission`),
    openIsyRequest<{ data?: any[] }>(service, "GET", `/api/session/${encodeURIComponent(sessionId)}/form`),
    openIsyRequest<{ data?: any[] }>(service, "GET", `/api/session/${encodeURIComponent(sessionId)}/inbox`),
    openIsyRequest<{ data?: Record<string, unknown> }>(service, "GET", "/api/session/active"),
  ]);

  if (!sessionRes.ok) {
    throw new Error(`No se pudo leer la sesión ${sessionId}: ${sessionRes.error}`);
  }
  const s = sessionRes.data?.data ?? sessionRes.data;
  const messages = summarizeMessages(msgRes.data?.data ?? []);

  return {
    session: {
      id: sessionId,
      parent_id: s?.parentID ?? null,
      title: s?.title,
      agent: s?.agent,
      model: s?.model,
      outcome: s?.outcome,
      running: Boolean(activeRes.data?.data?.[sessionId]),
      directory: s?.location?.directory,
    },
    pending_permissions: permRes.data?.data ?? [],
    pending_forms: formRes.data?.data ?? [],
    inbox: inboxRes.data?.data ?? [],
    messages,
  };
}

// ─── 3. openisy.send: hablar como usuario (prompt/steer/queue), como agente (synthetic) o comando ─

export async function sendToOpenIsySession(args: Record<string, any> = {}) {
  const text = String(args.text ?? args.prompt ?? args.message ?? "").trim();
  if (!text) throw new Error("openisy.send requiere 'text' (o 'prompt').");

  const service = ensureOpenIsyService({
    target: args.target,
    serverUrl: args.server_url,
    password: args.password,
  });
  const sessionId = await resolveSessionId(service, args.session_id, args.directory);
  const mode = String(args.as ?? "user").trim().toLowerCase();
  const delivery = args.delivery === "queue" || args.delivery === "steer" ? args.delivery : undefined;

  let sendRes: { ok: boolean; status: number; data: any; error?: string };
  if (mode === "synthetic" || mode === "agent" || mode === "system") {
    sendRes = await openIsyRequest(service, "POST", `/api/session/${encodeURIComponent(sessionId)}/synthetic`, {
      body: {
        text,
        ...(args.description ? { description: String(args.description) } : {}),
        ...(delivery ? { delivery } : {}),
        ...(typeof args.resume === "boolean" ? { resume: args.resume } : {}),
      },
    });
  } else if (mode === "command") {
    const name = String(args.command_name ?? args.name ?? "").trim();
    if (!name) throw new Error("openisy.send con as='command' requiere 'command_name' (ej. 'compact').");
    sendRes = await openIsyRequest(service, "POST", `/api/session/${encodeURIComponent(sessionId)}/command`, {
      body: {
        name,
        text,
        ...(delivery ? { delivery } : {}),
      },
    });
  } else {
    const agents = Array.isArray(args.agents)
      ? args.agents.map((a: any) => (typeof a === "string" ? { name: a } : a))
      : undefined;
    sendRes = await openIsyRequest(service, "POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      body: {
        text,
        ...(delivery ? { delivery } : {}),
        ...(agents ? { agents } : {}),
        ...(typeof args.resume === "boolean" ? { resume: args.resume } : {}),
      },
    });
  }

  if (!sendRes.ok) {
    throw new Error(`Fallo al enviar a la sesión ${sessionId} (as=${mode}): ${sendRes.error}`);
  }

  let reply: Record<string, unknown> | undefined;
  if (args.wait === true) {
    const timeoutMs = Number(args.timeout_ms ?? 180_000);
    await openIsyRequest(service, "POST", `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, {
      timeoutMs,
    });
    const msgRes = await openIsyRequest<{ data?: any[] }>(
      service,
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/message`,
      { query: { limit: 4, order: "desc" } },
    );
    const summarized = summarizeMessages(msgRes.data?.data ?? []);
    reply = summarized.find((m) => m.type === "assistant") ?? summarized[0];
  }

  return {
    session_id: sessionId,
    as: mode,
    delivery: delivery ?? "default",
    admitted: sendRes.data,
    ...(reply ? { assistant_reply: reply } : {}),
  };
}

// ─── 4. openisy.control: cambiar modelo/agente, aprobar permisos, interrumpir, env ──

export async function controlOpenIsySession(args: Record<string, any> = {}) {
  const service = ensureOpenIsyService({
    target: args.target,
    serverUrl: args.server_url,
    password: args.password,
  });
  const sessionId = await resolveSessionId(service, args.session_id, args.directory);
  const actionsTaken: Array<{ op: string; ok: boolean; detail?: unknown; error?: string }> = [];

  if (args.interrupt === true) {
    const r = await openIsyRequest(service, "POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`);
    actionsTaken.push({ op: "interrupt", ok: r.ok, detail: r.data, error: r.error });
  }

  if (args.agent) {
    const r = await openIsyRequest(service, "POST", `/api/session/${encodeURIComponent(sessionId)}/agent`, {
      body: { agent: String(args.agent) },
    });
    actionsTaken.push({ op: "switch_agent", ok: r.ok, detail: r.data, error: r.error });
  }

  if (args.model || args.provider) {
    const modelRef = parseModelRef(args.model, args.provider, args.variant);
    if (!modelRef) throw new Error("Para cambiar de modelo indica 'model' (ej. 'xkiro/x-ai/grok-4.5' o { providerID, id }).");
    const r = await openIsyRequest(service, "POST", `/api/session/${encodeURIComponent(sessionId)}/model`, {
      body: { model: modelRef },
    });
    actionsTaken.push({ op: "switch_model", ok: r.ok, detail: { model: modelRef, response: r.data }, error: r.error });
  }

  if (args.env && typeof args.env === "object" && !Array.isArray(args.env)) {
    const variables: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.env)) {
      if (v !== undefined && v !== null) variables[k] = String(v);
    }
    const r = await openIsyRequest(service, "PUT", `/api/session/${encodeURIComponent(sessionId)}/environment`, {
      body: { variables },
    });
    actionsTaken.push({
      op: "set_environment",
      ok: r.ok,
      detail: { keys: Object.keys(variables) },
      error: r.error,
    });
  }

  if (args.permission_decision || args.approve_permissions) {
    const decision = String(args.permission_decision ?? args.approve_permissions) as "once" | "always" | "reject";
    const reqId = args.permission_id ? String(args.permission_id) : undefined;
    if (reqId) {
      const r = await openIsyRequest(
        service,
        "POST",
        `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(reqId)}/reply`,
        { body: { decision, ...(args.permission_message ? { message: String(args.permission_message) } : {}) } },
      );
      actionsTaken.push({ op: "permission_reply", ok: r.ok, detail: { request_id: reqId, decision }, error: r.error });
    } else {
      const pending = await openIsyRequest<{ data?: Array<{ id: string }> }>(
        service,
        "GET",
        `/api/session/${encodeURIComponent(sessionId)}/permission`,
      );
      const list = pending.data?.data ?? [];
      for (const p of list) {
        const r = await openIsyRequest(
          service,
          "POST",
          `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(p.id)}/reply`,
          { body: { decision } },
        );
        actionsTaken.push({ op: "permission_reply", ok: r.ok, detail: { request_id: p.id, decision }, error: r.error });
      }
      if (list.length === 0) {
        actionsTaken.push({ op: "permission_reply", ok: true, detail: "no_pending_permissions" });
      }
    }
  }

  if (args.form_id && args.form_reply !== undefined) {
    const r = await openIsyRequest(
      service,
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(String(args.form_id))}/reply`,
      { body: args.form_reply },
    );
    actionsTaken.push({ op: "form_reply", ok: r.ok, detail: { form_id: args.form_id }, error: r.error });
  }

  return {
    session_id: sessionId,
    actions: actionsTaken,
  };
}

// ─── 5. openisy.subagent: despachar sub-agentes en OpenISy o con API keys de otros providers ─

export async function runOpenIsySubagent(args: Record<string, any> = {}) {
  const prompt = String(args.prompt ?? args.text ?? "").trim();
  if (!prompt) throw new Error("openisy.subagent requiere 'prompt'.");

  // Modo Direct API: si pasan base_url + api_key (o direct_api: true) para pegarle directo a un endpoint compatible con OpenAI/Anthropic
  if (args.direct_api === true || (args.base_url && args.api_key && !args.use_openisy_tools)) {
    const baseUrl = String(args.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const apiKey = String(args.api_key ?? "").trim();
    if (!apiKey) throw new Error("direct_api requiere 'api_key'.");
    const model = String(args.model ?? "gpt-4o-mini").trim();
    const system = args.system ? String(args.system) : undefined;
    const timeoutMs = Number(args.timeout_ms ?? 120_000);
    const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ];
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        ...(typeof args.temperature === "number" ? { temperature: args.temperature } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      throw new Error(`Error del provider externo (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
    }
    const replyText = data?.choices?.[0]?.message?.content ?? "";
    return {
      mode: "direct_api",
      base_url: baseUrl,
      model,
      assistant_text: replyText,
      usage: data?.usage,
    };
  }

  // Modo Nativo OpenISy: crea una sesión de sub-agente real en OpenISy (con todas sus tools, ziggrep, bash, etc.)
  const service = ensureOpenIsyService({
    target: args.target,
    serverUrl: args.server_url,
    password: args.password,
  });

  const directory = args.cwd || args.directory ? String(args.cwd ?? args.directory) : process.cwd();
  let parentID: string | null = null;
  if (args.parent_session_id) {
    parentID = await resolveSessionId(service, String(args.parent_session_id), directory);
  } else if (args.attach_to_active === true) {
    parentID = await resolveSessionId(service, "active", directory);
  }

  const modelRef = parseModelRef(args.model, args.provider, args.variant);
  const agent = String(args.agent ?? "general").trim();
  const title = String(args.title ?? `Subagent (${agent}${modelRef ? ` · ${modelRef.providerID}/${modelRef.id}` : ""}): ${prompt.slice(0, 48)}`).trim();
  const autoApprove = args.auto_approve !== false;

  const createBody: Record<string, unknown> = {
    title,
    agent,
    location: { directory },
    ...(parentID ? { parentID } : {}),
    ...(modelRef ? { model: modelRef } : {}),
    ...(autoApprove
      ? {
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
          ],
        }
      : {}),
  };

  const created = await openIsyRequest<{ data?: { id: string }; id?: string }>(service, "POST", "/api/session", {
    body: createBody,
  });
  if (!created.ok) {
    throw new Error(`No se pudo crear la sesión del sub-agente en OpenISy: ${created.error}`);
  }
  const childSessionId = created.data?.data?.id ?? created.data?.id;
  if (!childSessionId) {
    throw new Error(`OpenISy no devolvió un session.id al crear el sub-agente: ${JSON.stringify(created.data)}`);
  }

  // Si se pasan API keys o variables de entorno específicas para esta sesión de sub-agente:
  const envVars: Record<string, string> = {};
  if (args.env && typeof args.env === "object" && !Array.isArray(args.env)) {
    for (const [k, v] of Object.entries(args.env)) {
      if (v !== undefined && v !== null) envVars[k] = String(v);
    }
  }
  if (args.api_key) {
    const envName = String(args.api_key_env ?? "OPENAI_API_KEY").trim();
    envVars[envName] = String(args.api_key);
  }
  if (Object.keys(envVars).length > 0) {
    await openIsyRequest(service, "PUT", `/api/session/${encodeURIComponent(childSessionId)}/environment`, {
      body: { variables: envVars },
    });
  }

  // Enviar el prompt al sub-agente:
  const promptRes = await openIsyRequest(service, "POST", `/api/session/${encodeURIComponent(childSessionId)}/prompt`, {
    body: { text: prompt },
  });
  if (!promptRes.ok) {
    throw new Error(`El sub-agente ${childSessionId} se creó pero falló el envío del prompt: ${promptRes.error}`);
  }

  const shouldWait = args.wait !== false;
  if (!shouldWait) {
    return {
      mode: "openisy_subagent_async",
      session_id: childSessionId,
      parent_session_id: parentID,
      agent,
      model: modelRef ?? "default",
      directory,
      status: "RUNNING",
      hint: `Usa isymcp(action='openisy.messages', arguments={ session_id: '${childSessionId}' }) para consultar su avance y respuesta.`,
    };
  }

  const timeoutMs = Number(args.timeout_ms ?? 300_000);
  const waitRes = await openIsyRequest(
    service,
    "POST",
    `/api/experimental/session/${encodeURIComponent(childSessionId)}/wait`,
    { timeoutMs },
  );

  const [sessionState, msgRes] = await Promise.all([
    openIsyRequest(service, "GET", `/api/session/${encodeURIComponent(childSessionId)}`),
    openIsyRequest<{ data?: any[] }>(
      service,
      "GET",
      `/api/session/${encodeURIComponent(childSessionId)}/message`,
      { query: { limit: 6, order: "desc" } },
    ),
  ]);

  const sData = sessionState.data?.data ?? sessionState.data;
  const messages = summarizeMessages(msgRes.data?.data ?? []);
  const assistantMsg = messages.find((m) => m.type === "assistant");
  const idleMsg = messages.find((m) => m.type === "idle");

  if (args.ephemeral === true) {
    await openIsyRequest(service, "DELETE", `/api/session/${encodeURIComponent(childSessionId)}`).catch(() => null);
  }

  return {
    mode: "openisy_subagent",
    session_id: childSessionId,
    parent_session_id: parentID,
    ephemeral: args.ephemeral === true,
    agent,
    model: sData?.model ?? modelRef ?? "default",
    directory,
    wait_completed: waitRes.ok,
    outcome: sData?.outcome ?? idleMsg?.outcome ?? (waitRes.ok ? "completed" : "running_or_timed_out"),
    ...(idleMsg?.error || assistantMsg?.error ? { error: idleMsg?.error ?? assistantMsg?.error } : {}),
    assistant_text: assistantMsg?.text ?? null,
    reasoning_text: assistantMsg?.reasoning ?? null,
    tool_calls: assistantMsg?.tool_calls ?? [],
    tokens: sData?.tokens,
    cost: sData?.cost,
  };
}
