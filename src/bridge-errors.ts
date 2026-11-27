// src/bridge-errors.ts — Catálogo de fallos del bridge para que el MODELO (ChatGPT) los explique.
//
// Antes, ChatGPT solo veía textos sueltos ("Session terminated", "fail-closed: ...", "DENIED: ...")
// y tenía que adivinar. Ahora cada fallo conocido tiene un código estable con:
//   layer       dónde falló (transporte/túnel, token, permisos, sandbox, argumentos, interno)
//   who_fixes   quién puede arreglarlo: "model" (reintenta distinto), "operator" (Danny en su terminal)
//   cause       qué pasó, en una frase
//   remedy      qué hacer
//   command     comando sugerido para el operador (nunca se ejecuta solo)
//
// Expuesto por tres vías:
//   1. Cada tool codex_* que falla devuelve `diagnosis` junto al error (main.ts → tracedCall).
//   2. Gateway: isymcp(action='errors.catalog' | 'errors.explain' | 'errors.recent').
//   3. La descripción de codex_turn_start lleva el resumen de TRANSPORTE: esos fallos ocurren antes de
//      llegar a este server (túnel caído), así que la única forma de que el modelo los entienda es que ya
//      los traiga en las descripciones que leyó al descubrir el connector.
//
// Determinista y local: no ejecuta nada. La bitácora (audit/errors.jsonl, 0600) guarda código, tool y
// mensaje recortado y sin credenciales; nunca tokens ni stdout.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bridgeHome } from "./codex-sessions";
import { auditLogPath } from "./permissions";

export type ErrorLayer = "transport" | "token" | "permission" | "sandbox" | "arguments" | "process" | "internal";
export type WhoFixes = "model" | "operator";

export interface BridgeErrorRule {
  layer: ErrorLayer;
  who_fixes: WhoFixes;
  cause: string;
  remedy: string;
  command?: string;
  /** Patrones (sobre el mensaje de error) que identifican este código. El primero que casa gana. */
  match: RegExp[];
}

export const BRIDGE_ERRORS = {
  // ── Transporte: el modelo los ve en SU lado; la llamada no llegó a este server ──
  transport_session_terminated: {
    layer: "transport",
    who_fixes: "operator",
    cause: "El túnel ChatGPT→máquina de Danny está caído o atascado (el tunnel-client dejó de hacer poll), o el MCP local se reinició y la sesión MCP que ChatGPT tenía ya no existe.",
    remedy: "Pide a Danny que reconecte el túnel. Si tras reconectar sigue igual, que refresque el connector en ChatGPT (Ajustes → Conectores) o abra un chat nuevo. No reintentes en bucle: sin túnel ninguna tool llega.",
    command: "isymcp tunnel status && isymcp tunnel connect",
    match: [/session terminated/i, /mcpservererror/i, /session not found/i, /unknown session/i],
  },
  transport_timeout: {
    layer: "transport",
    who_fixes: "operator",
    cause: "La llamada no recibió respuesta a tiempo: túnel lento/atascado o la máquina de Danny suspendida o sin red.",
    remedy: "Reintenta una vez. Si vuelve a fallar, pide a Danny revisar el túnel y que la máquina esté despierta.",
    command: "isymcp tunnel status && isymcp tunnel connect",
    match: [/\btimed? ?out\b/i, /etimedout/i, /gateway time-?out/i, /\b504\b/, /deadline exceeded/i],
  },
  transport_unreachable: {
    layer: "transport",
    who_fixes: "operator",
    cause: "El connector no pudo alcanzar el MCP local (túnel detenido, server caído o connector desvinculado).",
    remedy: "Pide a Danny levantar ISyMCP y reconectar el túnel; si el connector desapareció, volver a vincularlo en ChatGPT.",
    command: "isymcp up && isymcp tunnel connect",
    match: [/econnrefused/i, /\b50[23]\b/, /bad gateway/i, /service unavailable/i, /connector.*(unavailable|not found|disconnected)/i, /tunnel.*(offline|not ready|stopped)/i],
  },

  // ── Token / sesión ──
  turn_token_missing: {
    layer: "token",
    who_fixes: "model",
    cause: "La llamada no llevó turn_token.",
    remedy: "Repite la llamada pasando el turn_token que Danny te dio en el prompt (el mismo para todas las tools del turno).",
    match: [/^(turn_token|request_id) requerido/i, /^(turn_token|request_id) y response requeridos/i],
  },
  turn_token_unknown: {
    layer: "token",
    who_fixes: "operator",
    cause: "El turn_token no corresponde a ninguna sesión viva en la máquina de Danny: caducó, se revocó (sandbox stop) o es de otra máquina/prompt viejo.",
    remedy: "Pide a Danny un prompt nuevo con token fresco. No inventes ni reutilices tokens de mensajes anteriores.",
    command: "isymcp sandbox exec",
    match: [/broker not connected \(v1 stub\)/i, /token (desconocido|no valido|invalido|caducado|expirado|revocado)/i],
  },
  session_read_only: {
    layer: "token",
    who_fixes: "operator",
    cause: "La sesión del token es de solo lectura: no puede escribir archivos.",
    remedy: "Limítate a leer, o pide a Danny una sesión con escritura (sin --ro).",
    command: "isymcp sandbox exec",
    match: [/sesion read-only/i, /read-only.*denegado/i],
  },

  // ── Permisos del operador ──
  permission_denied: {
    layer: "permission",
    who_fixes: "operator",
    cause: "El permiso del operador para esa capacidad está apagado (shell_exec en el host o abrir consolas de agentes).",
    remedy: "No intentes rodearlo. Pide a Danny que lo encienda si de verdad hace falta; mientras, usa codex_exec (sandbox).",
    command: "isymcp allow shell on --for 2h   # o: isymcp allow agents on --for 2h",
    match: [/^DENIED:/, /agent_spawn_disabled/i, /host_shell.*(disabled|denied)/i],
  },
  permission_expired: {
    layer: "permission",
    who_fixes: "operator",
    cause: "El permiso existía pero ya caducó (TTL de `isymcp allow` o de la sesión sandbox).",
    remedy: "Pide a Danny que lo renueve con la duración que necesites.",
    command: "isymcp allow shell on --for 2h",
    match: [/\bexpired\b/i, /caduc(o|ó|ado)/i],
  },
  permission_tainted: {
    layer: "permission",
    who_fixes: "operator",
    cause: "Leíste contenido externo en este turno y la política exige una aprobación de un solo uso del operador para ejecutar en el host.",
    remedy: "Explica a Danny qué quieres ejecutar y por qué; él aprueba un uso puntual.",
    command: "isymcp allow once shell",
    match: [/taint/i, /contaminad/i],
  },

  // ── Sandbox ──
  sandbox_unavailable: {
    layer: "sandbox",
    who_fixes: "operator",
    cause: "El sandbox (bwrap en Linux, Docker en Windows) no está disponible, así que la ejecución se cierra por seguridad (fail-closed).",
    remedy: "Pide a Danny que revise el sandbox con el doctor.",
    command: "isymcp doctor",
    match: [/^fail-closed:/i, /bwrap.*(not found|no disponible|failed)/i],
  },
  path_outside_workspace: {
    layer: "sandbox",
    who_fixes: "model",
    cause: "La ruta o cwd está fuera del workspace de la sesión o no existe.",
    remedy: "Usa rutas dentro de session.cwd (relativas a él). Revisa el cwd con codex_tool_inventory.",
    match: [/fuera del workspace/i],
  },
  sandbox_spawn_failed: {
    layer: "sandbox",
    who_fixes: "operator",
    cause: "El proceso no pudo arrancar dentro del sandbox.",
    remedy: "Reintenta una vez; si persiste, pide a Danny ver los logs.",
    command: "isymcp logs",
    match: [/spawn fallo/i, /patch sandbox fallo/i, /no se pudo preparar apply_patch/i],
  },

  // ── Argumentos (los arregla el modelo) ──
  invalid_arguments: {
    layer: "arguments",
    who_fixes: "model",
    cause: "Los argumentos no cumplen el esquema de la tool.",
    remedy: "Corrige los argumentos según codex_tool_inventory (o isymcp(action='describe', arguments={name})) y reintenta.",
    match: [/arguments no validos/i, /no es un json valido/i, /debe ser (un|una)/i, /requerido$/i, /no se detectaron paths/i, /invalid_type|invalid input/i],
  },
  tool_unsupported: {
    layer: "arguments",
    who_fixes: "model",
    cause: "La tool o acción pedida no existe en este bridge.",
    remedy: "Lista las disponibles con codex_tool_inventory o isymcp(action='glossary') y usa un nombre exacto.",
    match: [/tool no soportada/i, /acci[oó]n no soportada/i, /acci[oó]n desconocida/i],
  },
  call_id_conflict: {
    layer: "arguments",
    who_fixes: "model",
    cause: "Reusaste un call_id con otra tool u otros argumentos.",
    remedy: "Usa un call_id nuevo para cada llamada distinta (el mismo solo para reintentar la misma).",
    match: [/call_id ya utilizado/i],
  },
  image_rejected: {
    layer: "arguments",
    who_fixes: "model",
    cause: "La imagen no es de un formato admitido (png/jpg/jpeg/webp/gif) o pasa de 8 MB.",
    remedy: "Convierte o reduce la imagen dentro del sandbox y vuelve a pedirla.",
    match: [/extension no soportada/i, /imagen demasiado grande/i],
  },

  // ── Procesos background ──
  exec_id_invalid: {
    layer: "process",
    who_fixes: "model",
    cause: "El exec_id no existe, caducó o es de otra sesión.",
    remedy: "Lanza el proceso de nuevo con codex_exec background=true y usa el exec_id que devuelva.",
    match: [/exec_id (desconocido|pertenece|requerido)/i],
  },
  process_finished: {
    layer: "process",
    who_fixes: "model",
    cause: "El proceso ya terminó o su stdin ya está cerrado.",
    remedy: "Lee el resultado final; si necesitas seguir, lanza otro proceso.",
    match: [/el proceso ya termino/i, /stdin ya esta cerrado/i],
  },
  busy_limit: {
    layer: "process",
    who_fixes: "model",
    cause: "Hay demasiadas tool calls pendientes en esta sesión.",
    remedy: "Espera a que terminen las pendientes (o ciérralas) antes de lanzar más.",
    match: [/limite de tool calls/i],
  },

  // ── Interno ──
  bootstrap_failed: {
    layer: "internal",
    who_fixes: "operator",
    cause: "El server local no pudo leer la guía de bootstrap o la tarea de la sesión.",
    remedy: "Pide a Danny revisar el server; mientras, puedes seguir con las tools si la sesión es válida.",
    command: "isymcp logs && isymcp doctor",
    match: [/local bootstrap failed/i],
  },
  internal_crash: {
    layer: "internal",
    who_fixes: "operator",
    cause: "Excepción no controlada dentro del server de ISyMCP (bug).",
    remedy: "Reporta a Danny el mensaje exacto; no es culpa de tus argumentos si estos eran válidos.",
    command: "isymcp logs",
    match: [/tool dispatch failed/i, /uncaught/i, /typeerror|referenceerror/i],
  },
  unknown: {
    layer: "internal",
    who_fixes: "operator",
    cause: "Fallo sin código conocido en el catálogo.",
    remedy: "Muestra a Danny el mensaje exacto y la tool; con isymcp(action='errors.recent') ves si se repite.",
    command: "isymcp logs",
    match: [],
  },
} satisfies Record<string, BridgeErrorRule>;

export type BridgeErrorCode = keyof typeof BRIDGE_ERRORS;

export interface Diagnosis {
  code: BridgeErrorCode;
  layer: ErrorLayer;
  who_fixes: WhoFixes;
  cause: string;
  remedy: string;
  command?: string;
}

function toDiagnosis(code: BridgeErrorCode): Diagnosis {
  const r: BridgeErrorRule = BRIDGE_ERRORS[code];
  return { code, layer: r.layer, who_fixes: r.who_fixes, cause: r.cause, remedy: r.remedy, ...(r.command ? { command: r.command } : {}) };
}

/** Diagnostica un mensaje de error (o un código ya conocido). Nunca lanza. */
export function diagnose(message: unknown): Diagnosis {
  const text = typeof message === "string" ? message.trim() : String(message ?? "").trim();
  if (text in BRIDGE_ERRORS) return toDiagnosis(text as BridgeErrorCode);
  for (const code of Object.keys(BRIDGE_ERRORS) as BridgeErrorCode[]) {
    if ((BRIDGE_ERRORS[code] as BridgeErrorRule).match.some((re) => re.test(text))) return toDiagnosis(code);
  }
  return toDiagnosis("unknown");
}

/** Catálogo para el modelo, sin los regex. */
export function errorCatalog(): Record<string, Omit<BridgeErrorRule, "match">> {
  return Object.fromEntries(
    (Object.entries(BRIDGE_ERRORS) as Array<[string, BridgeErrorRule]>).map(([code, { match: _m, ...rest }]) => [code, rest]),
  );
}

/**
 * Resumen corto de TRANSPORTE para las descripciones de tools. El modelo lo lee al descubrir el
 * connector, así que le sirve incluso cuando el túnel está caído y ninguna llamada llega aquí.
 */
export const TRANSPORT_HINT =
  " Si una tool falla ANTES de llegar a la máquina de Danny ('Session terminated', McpServerError, timeout, 502/503/504): " +
  "el túnel local está caído o atascado; no es tu culpa ni del token — dile a Danny que corra `isymcp tunnel connect`. " +
  "Los demás fallos traen `diagnosis` {code, cause, remedy, who_fixes, command}; catálogo completo: isymcp(action='errors.catalog'), " +
  "últimos fallos: isymcp(action='errors.recent').";

// ── Bitácora de errores ────────────────────────────────────────────────────

const SECRETISH = /(bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32,})/gi;

export function errorsLogPath(env: Record<string, string | undefined> = process.env): string {
  return join(bridgeHome(env), "audit", "errors.jsonl");
}

function scrub(text: string, max = 300): string {
  const clean = text.replace(SECRETISH, "[redacted]");
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

export interface ErrorEvent {
  ts: string;
  tool: string;
  code: BridgeErrorCode;
  message: string;
  session?: string | null;
}

/** Registra un fallo. Nunca rompe la tool que lo llama. */
export function recordError(tool: string, message: string, extra: { session?: string | null; code?: BridgeErrorCode } = {},
  env: Record<string, string | undefined> = process.env): ErrorEvent | null {
  try {
    const event: ErrorEvent = {
      ts: new Date().toISOString(),
      tool,
      code: extra.code ?? diagnose(message).code,
      message: scrub(message),
      ...(extra.session !== undefined ? { session: extra.session } : {}),
    };
    const path = errorsLogPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* mejor esfuerzo */ }
    return event;
  } catch {
    return null;
  }
}

/** Últimas `n` líneas JSON de un archivo (lee como mucho los últimos 256 KiB). */
function tailJsonl(path: string, n: number): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  try {
    const size = statSync(path).size;
    const raw = readFileSync(path, "utf8");
    const text = size > 256 * 1024 ? raw.slice(-256 * 1024) : raw;
    const out: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n").reverse()) {
      if (out.length >= n) break;
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* línea parcial o corrupta */ }
    }
    return out;
  } catch {
    return [];
  }
}

export interface TunnelHealth {
  profile: string;
  log: string;
  last_event_at: string | null;
  /** poll timeouts seguidos desde la última recuperación (≥3 = atascado). */
  consecutive_poll_timeouts: number;
  stuck: boolean;
}

/**
 * Salud de los tunnel-client según su log JSON (perfil → log.file). Sirve para explicar a posteriori
 * por qué hubo 'Session terminated': si el poller lleva varios timeouts seguidos, el túnel está atascado.
 */
export function tunnelHealth(env: Record<string, string | undefined> = process.env): TunnelHealth[] {
  const dir = join(bridgeHome(env), "tunnel", "profiles");
  if (!existsSync(dir)) return [];
  const out: TunnelHealth[] = [];
  for (const name of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    try {
      const cfg = JSON.parse(readFileSync(join(dir, name), "utf8")) as { log?: { file?: string } };
      const log = cfg.log?.file?.replace(/^~(?=\/)/, homedir());
      if (!log || !existsSync(log)) continue;
      const lines = tailJsonl(log, 60);
      let timeouts = 0;
      for (const ev of lines) {
        const msg = String(ev.msg ?? "");
        if (/poll (timed out|failed)/.test(msg)) timeouts++;
        else if (/poller recovered|tunnel-client started|polling operational/.test(msg)) break;
      }
      out.push({
        profile: name.replace(/\.ya?ml$/, ""),
        log,
        last_event_at: typeof lines[0]?.time === "string" ? lines[0].time as string : null,
        consecutive_poll_timeouts: timeouts,
        stuck: timeouts >= 3,
      });
    } catch { /* perfil ilegible: se omite */ }
  }
  return out;
}

/** Lo que devuelve errors.recent: fallos de tools, denegaciones de permisos y salud del túnel. */
export function recentErrors(limit = 20, env: Record<string, string | undefined> = process.env) {
  const n = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
  const tools = (tailJsonl(errorsLogPath(env), n) as unknown as ErrorEvent[])
    .map((e) => ({ ...e, diagnosis: diagnose(String(e.code ?? e.message ?? "")) }));
  const denials = tailJsonl(auditLogPath(env), 200)
    .filter((e) => e.decision === "deny")
    .slice(0, n)
    .map((e) => ({
      ts: e.ts,
      action: e.action,
      reason: e.reason ?? null,
      command: typeof e.command === "string" ? scrub(e.command, 160) : undefined,
      diagnosis: diagnose(e.reason === "expired" ? "permission_expired" : String(e.reason ?? "DENIED:")),
    }));
  return { tool_errors: tools, permission_denials: denials, tunnels: tunnelHealth(env) };
}
