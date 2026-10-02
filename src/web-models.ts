// web-models.ts — catalogo Web clonado (M3, subset visible).
//
// Derivado del comportamiento de `codex-chatgpt-web` @
// 324c52c75f1d87c65ee4b94ee71efd2dce1b4ebf (MIT). Ver
// THIRD_PARTY_NOTICES.md. No se copia el archivo completo de la referencia:
// se reimplementa el subset visible (Luna / Instant / Sol / Pro / GPT-6 Pro)
// con sus reglas de disponibilidad, efforts y limites de contexto.
//
// Las filas se construyen clonando un modelo nativo "template" del catalogo
// de Codex (mismo mecanismo que la referencia): asi heredan campos que no
// tocamos y solo se sobrescribe lo que este bridge implementa.

export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";

export const INSTANT_CONTEXT_WINDOW = 41_000;
export const INSTANT_AUTO_COMPACT_TOKEN_LIMIT = 32_000;
export const MEDIUM_HIGH_CONTEXT_WINDOW = 90_000;
export const MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT = 80_000;
export const PRO_AUTO_COMPACT_TOKEN_LIMIT = 95_000;
export const PRO_STANDARD_MESSAGE_TOKEN_LIMIT = 103_000;
export const PRO_MODEL_MESSAGE_TOKEN_LIMIT = 104_000;
export const PLATFORM_RESERVE_TOKENS = 8_192;
export const PRO_STANDARD_CONTEXT_WINDOW = PRO_STANDARD_MESSAGE_TOKEN_LIMIT + PLATFORM_RESERVE_TOKENS + 1;
export const PRO_MODEL_CONTEXT_WINDOW = PRO_MODEL_MESSAGE_TOKEN_LIMIT + PLATFORM_RESERVE_TOKENS + 1;
export const LUNA_CONTEXT_WINDOW = 1_050_000;
export const BIGGER_CONTEXT_MULTIPLIER = 3;

export type CodexEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AccountCapabilities {
  solAvailable: boolean;
  extraHighAvailable?: boolean;
  proAvailable: boolean;
  biggerContext?: boolean;
}

export interface WebModelRoute {
  slug: string;
  displayName: string;
  description: string;
  backendModel: "gpt-5.6-sol" | "gpt-5.6-luna";
  defaultEffort: CodexEffort;
  supportedEfforts: readonly CodexEffort[];
  requiresSol: boolean;
  requiresPro: boolean;
  requiresExtraHigh?: boolean;
  lunaOnly?: boolean;
}

const LUNA_ROUTE: WebModelRoute = {
  slug: "chatgpt-web/gpt-5.6-luna",
  displayName: "GPT-5.6 Luna (Web)",
  description: "ChatGPT Luna. Light selects the ordinary mode; Medium enables Think.",
  backendModel: "gpt-5.6-luna",
  defaultEffort: "low",
  supportedEfforts: ["low", "medium"],
  requiresSol: false,
  requiresPro: false,
  lunaOnly: true,
};

const SOL_INSTANT_ROUTE: WebModelRoute = {
  slug: "chatgpt-web/gpt-5.6-sol-instant",
  displayName: "GPT-5.6 Sol Instant (Web)",
  description: "GPT-5.6 Sol Instant through ChatGPT, with its own context and compaction budget.",
  backendModel: "gpt-5.6-sol",
  defaultEffort: "low",
  supportedEfforts: ["low"],
  requiresSol: true,
  requiresPro: false,
};

const SOL_ROUTE: WebModelRoute = {
  slug: "chatgpt-web/gpt-5.6-sol",
  displayName: "GPT-5.6 Sol (Web)",
  description: "GPT-5.6 Sol through ChatGPT with Medium, High, or account-supported Extra High reasoning.",
  backendModel: "gpt-5.6-sol",
  defaultEffort: "high",
  supportedEfforts: ["medium", "high", "xhigh"],
  requiresSol: true,
  requiresPro: false,
};

const PRO_ROUTE: WebModelRoute = {
  slug: "chatgpt-web/gpt-5.6-pro",
  displayName: "GPT-5.6 Pro (Web)",
  description: "GPT-5.6 Pro through ChatGPT. The fixed Max effort selects Pro.",
  backendModel: "gpt-5.6-sol",
  defaultEffort: "max",
  supportedEfforts: ["max"],
  requiresSol: true,
  requiresPro: true,
};

const GPT6_PRO_ROUTE: WebModelRoute = {
  slug: "chatgpt-web/gpt-6-pro",
  displayName: "GPT-6 Pro (Web)",
  description: "GPT-6 Pro through ChatGPT. The fixed Max effort selects Pro.",
  backendModel: "gpt-5.6-sol",
  defaultEffort: "max",
  supportedEfforts: ["max"],
  requiresSol: true,
  requiresPro: true,
};

const VISIBLE_ROUTES: readonly WebModelRoute[] = [
  LUNA_ROUTE,
  SOL_INSTANT_ROUTE,
  SOL_ROUTE,
  PRO_ROUTE,
  GPT6_PRO_ROUTE,
];

export function availableRoutes(caps: AccountCapabilities): readonly WebModelRoute[] {
  if (!caps.solAvailable) {
    return VISIBLE_ROUTES.filter((route) => route.lunaOnly === true);
  }
  return VISIBLE_ROUTES.filter(
    (route) =>
      !route.lunaOnly &&
      (!route.requiresPro || caps.proAvailable) &&
      (!route.requiresExtraHigh || caps.extraHighAvailable === true),
  );
}

export function routeEfforts(route: WebModelRoute, caps: AccountCapabilities): readonly CodexEffort[] {
  return route.supportedEfforts.filter((effort) => effort !== "xhigh" || caps.extraHighAvailable === true);
}

export interface ContextLimits {
  contextWindow: number;
  effectiveContextWindowPercent: number;
  autoCompactTokenLimit: number;
}

function limits(contextWindow: number, autoCompactTokenLimit: number): ContextLimits {
  return {
    contextWindow,
    effectiveContextWindowPercent: Math.round((autoCompactTokenLimit / contextWindow) * 100),
    autoCompactTokenLimit,
  };
}

export function resolveLimits(
  backendModel: WebModelRoute["backendModel"],
  effort: CodexEffort,
  caps: AccountCapabilities,
): ContextLimits {
  let base: ContextLimits;
  if (backendModel === "gpt-5.6-luna") {
    base = limits(LUNA_CONTEXT_WINDOW, LUNA_CONTEXT_WINDOW);
  } else if (caps.proAvailable) {
    const contextWindow = effort === "max" ? PRO_MODEL_CONTEXT_WINDOW : PRO_STANDARD_CONTEXT_WINDOW;
    base = limits(contextWindow, PRO_AUTO_COMPACT_TOKEN_LIMIT);
  } else if (effort === "low") {
    base = limits(INSTANT_CONTEXT_WINDOW, INSTANT_AUTO_COMPACT_TOKEN_LIMIT);
  } else if (effort === "medium" || effort === "high" || (effort === "xhigh" && caps.extraHighAvailable)) {
    base = limits(MEDIUM_HIGH_CONTEXT_WINDOW, MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT);
  } else {
    throw new Error(`limite de contexto no definido para effort ${effort}`);
  }
  if (!caps.biggerContext) return base;
  return limits(base.contextWindow * BIGGER_CONTEXT_MULTIPLIER, base.autoCompactTokenLimit * BIGGER_CONTEXT_MULTIPLIER);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function reasoningLevel(template: JsonObject, effort: string, description: string): JsonObject {
  const levels = Array.isArray(template.supported_reasoning_levels)
    ? (template.supported_reasoning_levels.filter(isObject) as JsonObject[])
    : [];
  const source = levels.find((level) => level.effort === effort);
  return { ...(source ? structuredClone(source) : {}), effort, description };
}

/** Clona el template nativo y produce la fila Web que Codex consume. */
export function buildWebModel(template: JsonObject, route: WebModelRoute, caps: AccountCapabilities): JsonObject {
  const efforts = routeEfforts(route, caps);
  if (efforts.length === 0) throw new Error(`${route.slug} no tiene efforts disponibles para esta cuenta`);
  const defaultLimits = resolveLimits(route.backendModel, route.defaultEffort, caps);
  for (const effort of efforts) {
    if (JSON.stringify(resolveLimits(route.backendModel, effort, caps)) !== JSON.stringify(defaultLimits)) {
      throw new Error(`Cannot group different context budgets under ${route.slug}`);
    }
  }
  const descriptions: Record<string, string> = {
    "chatgpt-web/gpt-5.6-luna": efforts.length === 1 ? route.displayName : "",
    "chatgpt-web/gpt-5.6-sol": "",
    "chatgpt-web/gpt-5.6-sol-instant": route.displayName,
  };
  const model: JsonObject = {
    ...structuredClone(template),
    slug: route.slug,
    display_name: route.displayName,
    description: route.description,
    input_modalities: ["text", "image"],
    visibility: "list",
    supported_in_api: true,
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: route.defaultEffort,
    supported_reasoning_levels: efforts.map((effort) =>
      reasoningLevel(
        template,
        effort,
        descriptions[route.slug] ??
          `${route.displayName} — ${effort === "xhigh" ? "Extra High" : effort}`,
      ),
    ),
    context_window: defaultLimits.contextWindow,
    max_context_window: defaultLimits.contextWindow,
    effective_context_window_percent: defaultLimits.effectiveContextWindowPercent,
    auto_compact_token_limit: defaultLimits.autoCompactTokenLimit,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  delete model.comp_hash;
  delete model.availability_nux;
  return model;
}

export function selectTemplate(models: JsonObject[]): JsonObject {
  const candidate = models.find(
    (model) =>
      typeof model.slug === "string" &&
      !model.slug.startsWith(CHATGPT_WEB_MODEL_PREFIX) &&
      model.visibility === "list" &&
      Array.isArray(model.supported_reasoning_levels),
  );
  if (!candidate) {
    throw new Error("catalogo nativo sin modelo template list-visible con reasoning levels");
  }
  return candidate;
}

/** Agrega las filas Web al catalogo nativo `{models:[...]}` sin mutarlo. */
export function augmentCatalog(value: unknown, caps: AccountCapabilities): JsonObject {
  if (!isObject(value) || !Array.isArray(value.models)) {
    throw new Error("catalogo nativo sin arreglo models");
  }
  const nativeModels = (value.models as unknown[]).filter(
    (model) => !(isObject(model) && typeof model.slug === "string" && model.slug.startsWith(CHATGPT_WEB_MODEL_PREFIX)),
  ) as JsonObject[];
  const template = selectTemplate(nativeModels);
  const webModels = availableRoutes(caps).map((route) => buildWebModel(template, route, caps));
  return { ...structuredClone(value), models: [...nativeModels, ...webModels] };
}

/** Diff de filas Web contra un catalogo de referencia. */
export interface CatalogDiff {
  missing: string[];
  extra: string[];
  ok: boolean;
}

export function diffWebRows(ours: unknown, reference: unknown): CatalogDiff {
  const rows = (value: unknown): string[] => {
    if (!isObject(value) || !Array.isArray(value.models)) return [];
    return (value.models as unknown[])
      .filter((model): model is JsonObject => isObject(model) && typeof model.slug === "string")
      .map((model) => model.slug as string)
      .filter((slug) => slug.startsWith(CHATGPT_WEB_MODEL_PREFIX));
  };
  const oursRows = new Set(rows(ours));
  const refRows = new Set(rows(reference));
  const missing = [...refRows].filter((slug) => !oursRows.has(slug));
  const extra = [...oursRows].filter((slug) => !refRows.has(slug));
  return { missing, extra, ok: missing.length === 0 };
}
