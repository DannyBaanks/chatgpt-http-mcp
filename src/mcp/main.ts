// src/mcp/main.ts — entry point del servidor MCP stdio para el túnel.
//
// Protocolo: Model Context Protocol sobre stdio (lo que tunnel-client espera
// como --mcp-command). Expone las 8 tools del Codex GPT MCP (contrato native).
//
// Con un turn_token que coincide con una sesion del registro
// (~/.codex-web-http/codex-sessions.json) TODAS las tools ejecutan de verdad
// con la politica de esa sesion (read-only | writable) y sandbox bwrap:
//   - codex_exec: comando foreground, o background=true → exec_id persistente
//   - codex_write_stdin: stdin de un proceso vivo + delta de salida
//   - codex_apply_patch: formato nativo Codex (*** Begin Patch) o git diff
//   - codex_view_image, codex_tool_inventory, codex_tool_call (dispatch
//     local a las tools nativas, mismo sandbox y sesion)
// Un token DESCONOCIDO conserva los receipts stub (compat OpenISy): nada
// ejecuta y codex_tool_inventory lo declara (tools: []).
//
// El nombre publico del app ("Codex ISyMCP"), el token @CODEX ISYMCP y las
// instructions viven en ./identity.ts; las shapes/descripciones/capacidades
// de las tools en ./catalog.ts — un solo lugar cada cosa, sin deriva.
//
//   bun run src/mcp/main.ts --contract native --broker-socket /tmp/codex-web-http-broker.sock
//
// Session tokens (v0.3): si el turn_token coincide con una sesion del registro
// (~/.codex-web-http/codex-sessions.json), las tools ejecutan de verdad con la
// politica de esa sesion (read-only | writable) y sandbox bwrap. Un token
// desconocido conserva el comportamiento stub (compat OpenISy).
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  bridgeHome,
  findSessionByToken,
  fingerprint,
  patchPaths,
  resolveWithin,
  resolveWithinReal,
  sandboxArgv,
  sandboxAvailable,
  type CodexSession,
} from "../codex-sessions";
import { applyCodexPatch, CodexPatchError } from "./codex-patch";
import { capabilities, shapesFor, TOOL_DESCRIPTIONS, WIRE_ALIASES, type ToolName } from "./catalog";
import { drain, findLive, killSessionExecs, registerLiveExec, writeStdin as stdinWrite, type BgProc } from "./exec-registry";
import { CODEX_TOOLS, buildInstructions } from "./identity";
import { serverIcon } from "./icon";
import { registerMediaTools } from "../media/register";

const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1]?.trim();
  if (!value) throw new Error(`${name} requiere un valor`);
  return value;
}

const contract = option("--contract", "native");
if (contract !== "native" && contract !== "safe") {
  throw new Error(`--contract debe ser native o safe, recibido: ${contract}`);
}
const brokerSocketPath = option("--broker-socket", "/tmp/codex-web-http-broker.sock");

const turnKey = contract === "safe" ? "request_id" : "turn_token";

/** Shapes registradas y anunciadas salen del catalogo: una sola fuente. */
const S = shapesFor(contract);

const server = new McpServer({
  name: "codex-web-http",
  version: "0.3.0",
  icons: [serverIcon()],
}, {
  instructions: buildInstructions(contract),
});

function jsonText(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function fail(reason: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: reason, ...extra }) }],
    isError: true as const,
  };
}

// Traza local (JSONL, 0600) de cada llamada al MCP: herramienta, fingerprint
// del token y sesion resuelta. Es la prueba independiente del modelo para
// verificar revocaciones (nunca escribe el token completo).
function trace(event: string, detail: Record<string, unknown>): void {
  try {
    mkdirSync(bridgeHome(), { recursive: true });
    appendFileSync(join(bridgeHome(), "mcp-trace.log"), `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`, { mode: 0o600 });
  } catch {
    /* la traza nunca debe romper el server */
  }
}

process.on("uncaughtException", (err) => {
  trace("uncaughtException", { message: String((err as Error)?.message ?? err) });
});
process.on("unhandledRejection", (err) => {
  trace("unhandledRejection", { message: String((err as Error)?.message ?? err) });
});

function sessionFrom(input: Record<string, unknown>, tool = "-"): CodexSession | null {
  const token = String(input[turnKey] ?? "");
  const session = token ? findSessionByToken(token) : null;
  trace("call", {
    tool,
    token_fp: token ? fingerprint(token) : null,
    session: session ? `${session.label}[${session.fp}]` : null,
    turn_id: session?.turnId ?? null,
  });
  return session;
}

/**
 * Evento de resultado por tool call: lo que el chat local muestra como
 * "tarjeta de tool". Va con token_fp (y turn_id si es un token de turno) para
 * correlacionar con el turno exacto. Nunca guarda stdout/stderr ni el token.
 */
function traceResult(session: CodexSession, tool: string, out: { content: Array<{ type: string; text?: string }>; isError?: boolean }): void {
  try {
    const text = out.content.find((c) => c.type === "text")?.text ?? "{}";
    const r = JSON.parse(text) as Record<string, unknown>;
    const clipStr = (v: unknown) => (typeof v === "string" ? v.slice(0, 300) : undefined);
    trace("tool.result", {
      tool,
      token_fp: session.fp,
      turn_id: session.turnId ?? null,
      ok: !out.isError && r.error === undefined && (r.executed !== false || tool === "codex_tool_inventory"),
      command: Array.isArray(r.command) ? (r.command as unknown[]).map(String).join(" ").slice(0, 300) : undefined,
      exit_code: typeof r.exit_code === "number" ? r.exit_code : undefined,
      timed_out: r.timed_out === true ? true : undefined,
      duration_ms: typeof r.duration_ms === "number" ? r.duration_ms : undefined,
      files: Array.isArray(r.files) ? (r.files as unknown[]).map(String).slice(0, 20) : undefined,
      path: clipStr(r.path),
      bytes: typeof r.bytes === "number" ? r.bytes : undefined,
      error: clipStr(r.error),
    });
  } catch {
    /* la traza nunca rompe la tool */
  }
}

function sessionMeta(session: CodexSession) {
  return { fp: session.fp, label: session.label, cwd: session.cwd, writable: session.writable };
}

function clip(text: string, max = 64 * 1024): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncado ${text.length - max} bytes]`;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v ?? "");
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function runExec(session: CodexSession, command: unknown, cwdArg: unknown, background?: unknown, captureMs?: unknown) {
  if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== "string" || !c.trim())) {
    return fail("command debe ser un argv no vacio de strings");
  }
  const workdir = resolveWithinReal(session.cwd, typeof cwdArg === "string" && cwdArg ? cwdArg : ".");
  if (!workdir || !existsSync(workdir) || !statSync(workdir).isDirectory()) {
    return fail(`cwd fuera del workspace o inexistente: ${String(cwdArg ?? ".")}`, { session: sessionMeta(session) });
  }
  const argv = sandboxArgv(session, workdir, command as string[]);
  if (!argv) {
    return fail("fail-closed: bwrap no disponible (sin sandbox no se ejecuta; CODEX_WEB_HTTP_SANDBOX=off solo habilita sesiones writable)", { session: sessionMeta(session) });
  }
  const started = Date.now();
  if (background === true) {
    // Proceso persistente: stdin abierto, exec_id para codex_write_stdin.
    // NO sufre el timeout de foreground; lo limita el TTL del registro.
    try {
      const proc = Bun.spawn(argv, {
        cwd: workdir,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
        env: process.env,
      }) as unknown as BgProc;
      const rec = registerLiveExec({ sessionFp: session.fp, command: command as string[], cwd: workdir, proc });
      trace("exec.bg.spawn", { exec_id: rec.id, writable: session.writable, workdir });
      const initial = await drain(rec, clampInt(captureMs, 0, 5000, 1500));
      return jsonText({
        executed: true,
        background: true,
        exec_id: rec.id,
        sandbox: sandboxAvailable() ? (session.writable ? "bwrap-workspace-write" : "bwrap-read-only") : "none",
        session: sessionMeta(session),
        command,
        cwd: workdir,
        stdout: clip(initial.stdout),
        stderr: clip(initial.stderr),
        alive: initial.alive,
        exit_code: initial.exitCode,
        expires_at: new Date(rec.expiresAt).toISOString(),
        duration_ms: Date.now() - started,
      });
    } catch (err) {
      return fail(`background spawn fallo: ${String(err)}`, { session: sessionMeta(session) });
    }
  }
  const execTimeoutMs = Number(process.env.CODEX_WEB_HTTP_EXEC_TIMEOUT_MS ?? "") || 60_000;
  let timedOut = false;
  try {
    // Async (no spawnSync): el server MCP no puede bloquear su event loop
    // (visto 2026-10-06: spawnSync con timeout dejaba el turno sin respuesta).
    const proc = Bun.spawn(argv, {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    trace("exec.spawn", { writable: session.writable, workdir });
    const timer = setTimeout(() => {
      timedOut = true;
      trace("exec.kill", {});
      proc.kill();
    }, execTimeoutMs);
    const stdout = await new Response(proc.stdout).text();
    trace("exec.stdout", { len: stdout.length });
    const stderr = await new Response(proc.stderr).text();
    trace("exec.stderr", { len: stderr.length });
    const exitCode = await proc.exited;
    trace("exec.exited", { exitCode, timedOut });
    clearTimeout(timer);
    return jsonText({
      executed: true,
      sandbox: sandboxAvailable() ? (session.writable ? "bwrap-workspace-write" : "bwrap-read-only") : "none",
      session: sessionMeta(session),
      command,
      cwd: workdir,
      exit_code: exitCode,
      timed_out: timedOut,
      stdout: clip(stdout),
      stderr: clip(stderr),
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    return fail(`spawn fallo: ${String(err)}`, { session: sessionMeta(session) });
  }
}

async function runApplyPatch(session: CodexSession, patch: unknown) {
  if (typeof patch !== "string" || !patch.trim()) return fail("patch requerido");
  if (!session.writable) return fail("sesion read-only: apply_patch denegado", { session: sessionMeta(session) });
  const { paths, codexFormat } = patchPaths(patch);
  if (codexFormat) {
    // Formato nativo Codex (*** Begin Patch): validacion completa en memoria
    // antes de escribir; un patch invalido no toca disco.
    try {
      const files = applyCodexPatch(session.cwd, patch);
      return jsonText({
        executed: true,
        format: "codex-native",
        session: sessionMeta(session),
        files,
        exit_code: 0,
        stdout: "",
        stderr: "",
      });
    } catch (err) {
      if (err instanceof CodexPatchError) return fail(err.message, { format: "codex-native", session: sessionMeta(session) });
      throw err;
    }
  }
  if (paths.length === 0) return fail("no se detectaron paths en el patch", { session: sessionMeta(session) });
  for (const p of paths) {
    if (!resolveWithin(session.cwd, p)) {
      return fail(`path fuera del workspace: ${p}`, { session: sessionMeta(session) });
    }
  }
  const tmpFile = join(tmpdir(), `isyco-patch-${process.pid}-${Date.now()}.diff`);
  try {
    // git apply exige newline final; los modelos suelen omitirlo.
    const normalizedPatch = patch.endsWith("\n") ? patch : `${patch}\n`;
    writeFileSync(tmpFile, normalizedPatch, { mode: 0o600 });
    const proc = Bun.spawn(["git", "apply", "--whitespace=nowarn", tmpFile], {
      cwd: session.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const timer = setTimeout(() => proc.kill(), 60_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return jsonText({
      executed: exitCode === 0,
      session: sessionMeta(session),
      files: [...new Set(paths)],
      exit_code: exitCode,
      stdout: clip(stdout),
      stderr: clip(stderr),
    });
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* tmp */
    }
  }
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function runViewImage(session: CodexSession, pathArg: unknown) {
  if (typeof pathArg !== "string" || !pathArg.trim()) return fail("path requerido");
  // Real: un symlink del workspace que apunta afuera no sirve para leer fuera.
  const abs = resolveWithinReal(session.cwd, pathArg);
  if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
    return fail(`path fuera del workspace o inexistente: ${pathArg}`, { session: sessionMeta(session) });
  }
  const mime = IMAGE_MIME[extname(abs).toLowerCase()];
  if (!mime) return fail("extension no soportada (png/jpg/jpeg/webp/gif)", { session: sessionMeta(session) });
  const bytes = statSync(abs).size;
  if (bytes > 8 * 1024 * 1024) return fail(`imagen demasiado grande: ${bytes} bytes (max 8MB)`);
  const data = readFileSync(abs).toString("base64");
  return {
    content: [
      { type: "image" as const, data, mimeType: mime },
      { type: "text" as const, text: JSON.stringify({ executed: true, session: sessionMeta(session), path: abs, bytes }) },
    ],
  };
}

/** Cuerpo de codex_write_stdin (tambien lo usa codex_tool_call). */
async function runWriteStdin(session: CodexSession, input: Record<string, unknown>) {
  const id = String(input.exec_id ?? "");
  if (!id) return fail("exec_id requerido", { session: sessionMeta(session) });
  const rec = findLive(id);
  if (!rec) return fail("exec_id desconocido o expirado", { session: sessionMeta(session) });
  if (rec.sessionFp !== session.fp) return fail("exec_id pertenece a otra sesion", { session: sessionMeta(session) });
  const signal = input.signal === "TERM" || input.signal === "KILL" ? (input.signal as "TERM" | "KILL") : undefined;
  if (rec.exited && !signal) {
    return fail("el proceso ya termino", { exec_id: id, exit_code: rec.exitCode, session: sessionMeta(session) });
  }
  if (rec.stdinClosed && !signal && input.close_stdin !== true) {
    return fail("el stdin ya esta cerrado", { exec_id: id, session: sessionMeta(session) });
  }
  const data = String(input.data ?? "");
  const out = await stdinWrite(rec, data, {
    close: input.close_stdin === true,
    signal,
    waitMs: clampInt(input.wait_ms, 0, 10_000, 2_000),
  });
  return jsonText({
    executed: true,
    exec_id: id,
    wrote: out.wrote,
    alive: out.alive,
    exit_code: out.exitCode,
    stdout: clip(out.stdout),
    stderr: clip(out.stderr),
    close_stdin: input.close_stdin === true,
    signal,
    session: sessionMeta(session),
  });
}

/** Inventario real de la sesion: solo tools ejecutables, con capacidades. */
function sessionInventory(session: CodexSession) {
  return jsonText({
    session: sessionMeta(session),
    tools: [...CODEX_TOOLS],
    capabilities: capabilities(contract),
    source: "codex-web-http sessions",
    sandbox: sandboxAvailable() ? "bwrap" : "none",
  });
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

function payloadOf(out: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  try {
    return JSON.parse(out.content.find((c) => c.type === "text")?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Dedupe de reintentos de codex_tool_call por call_id (10 min, cap 64). */
const toolCallCache = new Map<string, { at: number; payload: Record<string, unknown> }>();
function rememberToolCall(key: string, payload: Record<string, unknown>): void {
  toolCallCache.set(key, { at: Date.now(), payload });
  if (toolCallCache.size > 64) {
    const oldest = toolCallCache.keys().next().value;
    if (oldest !== undefined) toolCallCache.delete(oldest);
  }
}

/** Dispatch local de codex_tool_call a las tools nativas ejecutables. */
async function dispatchTool(session: CodexSession, tool: "codex_exec" | "codex_write_stdin" | "codex_apply_patch" | "codex_view_image" | "codex_tool_inventory", args: Record<string, unknown>) {
  switch (tool) {
    case "codex_exec":
      return runExec(session, args.command, args.cwd, args.background, args.capture_ms);
    case "codex_apply_patch":
      return runApplyPatch(session, args.patch);
    case "codex_view_image":
      return runViewImage(session, args.path);
    case "codex_write_stdin":
      return runWriteStdin(session, args);
    case "codex_tool_inventory":
      return sessionInventory(session);
  }
}

async function runToolCall(session: CodexSession, input: Record<string, unknown>) {
  const wire = String(input.wire_name ?? "");
  const tool = WIRE_ALIASES[wire] as ToolName | undefined;
  if (!tool || (tool !== "codex_exec" && tool !== "codex_write_stdin" && tool !== "codex_apply_patch" && tool !== "codex_view_image" && tool !== "codex_tool_inventory")) {
    return fail(`tool no soportada por el harness: ${wire}; usa codex_tool_inventory para ver las disponibles`, { session: sessionMeta(session) });
  }
  // arguments: objeto directo, o JSON de arguments en input (tool "custom").
  let args: Record<string, unknown> = {};
  if (input.arguments !== undefined && input.arguments !== null && typeof input.arguments === "object" && !Array.isArray(input.arguments)) {
    args = input.arguments as Record<string, unknown>;
  } else if (typeof input.input === "string" && input.input.trim()) {
    try {
      const parsed: unknown = JSON.parse(input.input);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return fail("input debe ser un objeto JSON de arguments", { session: sessionMeta(session) });
      }
      args = parsed as Record<string, unknown>;
    } catch {
      return fail("input no es un JSON valido de arguments", { session: sessionMeta(session) });
    }
  }
  // Validar contra el contrato de la tool (misma shape que el registro).
  const check = z.object(S[tool]).safeParse({ [turnKey]: input[turnKey], ...args });
  if (!check.success) {
    const detail = check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return fail(`arguments no validos para ${tool}: ${detail}`, { session: sessionMeta(session) });
  }
  // call_id: un reintento con el mismo call_id no re-ejecuta.
  const callId = typeof input.call_id === "string" ? input.call_id : null;
  const cacheKey = callId ? `${callId}|${tool}|${stableStringify(args)}` : null;
  if (cacheKey) {
    const hit = toolCallCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 10 * 60_000) {
      return jsonText({ replayed: true, wire_name: wire, ...hit.payload });
    }
  }
  const out = await dispatchTool(session, tool, args);
  if (cacheKey && !out.isError) {
    rememberToolCall(cacheKey, payloadOf(out));
  }
  return out;
}

server.registerTool(
  "codex_turn_start",
  {
    description: TOOL_DESCRIPTIONS.codex_turn_start,
    inputSchema: S.codex_turn_start,
  },
  async (input: Record<string, unknown>) => {
    const token = String(input[turnKey] ?? "");
    if (!token) return fail(`${turnKey} requerido`);
    const session = sessionFrom(input, "codex_turn_start");
    if (session) return jsonText({ started: true, session: sessionMeta(session) });
    return jsonText({ started: true, turn_token: token });
  },
);

server.registerTool(
  "codex_exec",
  {
    description: TOOL_DESCRIPTIONS.codex_exec,
    inputSchema: S.codex_exec,
  },
  async (input: Record<string, unknown>) => {
    const token = String(input[turnKey] ?? "");
    if (!token) return fail(`${turnKey} requerido`);
    const session = sessionFrom(input, "codex_exec");
    if (session) { const out = await runExec(session, input.command, input.cwd, input.background, input.capture_ms); traceResult(session, "codex_exec", out); return out; }
    const command = input.command as string[];
    return jsonText({
      turn_token: token,
      requested: command,
      receipt: "V1: broker no implementado; comando recibido y registrado",
      executed: false,
      stdout: "",
      stderr: "broker not connected (V1 stub)",
      exit_code: null,
    });
  },
);

server.registerTool(
  "codex_turn_complete",
  {
    description: TOOL_DESCRIPTIONS.codex_turn_complete,
    inputSchema: S.codex_turn_complete,
  },
  async (input: Record<string, unknown>) => {
    const token = String(input[turnKey] ?? "");
    const response = String(input.response ?? "");
    if (!token || !response) {
      return fail(`${turnKey} y response requeridos`);
    }
    const session = sessionFrom(input, "codex_turn_complete");
    if (session) {
      // Cerrar el turno no deja procesos huérfanos de esa sesion.
      const killed = killSessionExecs(session.fp);
      return jsonText({ completed: true, session: sessionMeta(session), live_execs_killed: killed });
    }
    return jsonText({ completed: true, turn_token: token });
  },
);

server.registerTool(
  "codex_tool_inventory",
  {
    description: TOOL_DESCRIPTIONS.codex_tool_inventory,
    inputSchema: S.codex_tool_inventory,
  },
  async (input: Record<string, unknown>) => {
    const session = sessionFrom(input, "codex_tool_inventory");
    if (session) {
      const out = sessionInventory(session);
      traceResult(session, "codex_tool_inventory", out);
      return out;
    }
    // Modo stub (token sin sesion): NADA es ejecutable. No se anuncian
    // tools que no corren; se dice como conseguir una sesion real.
    return jsonText({
      tools: [],
      source: "codex-web-http V1 stub",
      reason: `${turnKey} no corresponde a una sesion registrada: en modo stub nada es ejecutable (isymcp session mint --cwd <dir> --write)`,
    });
  },
);

server.registerTool(
  "codex_write_stdin",
  {
    description: TOOL_DESCRIPTIONS.codex_write_stdin,
    inputSchema: S.codex_write_stdin,
  },
  async (input: Record<string, unknown>) => {
    const session = sessionFrom(input, "codex_write_stdin");
    if (session) { const out = await runWriteStdin(session, input); traceResult(session, "codex_write_stdin", out); return out; }
    return jsonText({
      turn_token: input[turnKey],
      receipt: "V1: broker no implementado",
    });
  },
);

server.registerTool(
  "codex_apply_patch",
  {
    description: TOOL_DESCRIPTIONS.codex_apply_patch,
    inputSchema: S.codex_apply_patch,
  },
  async (input: Record<string, unknown>) => {
    const session = sessionFrom(input, "codex_apply_patch");
    if (session) { const out = await runApplyPatch(session, input.patch); traceResult(session, "codex_apply_patch", out); return out; }
    return jsonText({
      turn_token: input[turnKey],
      receipt: "V1: broker no implementado",
    });
  },
);

server.registerTool(
  "codex_view_image",
  {
    description: TOOL_DESCRIPTIONS.codex_view_image,
    inputSchema: S.codex_view_image,
  },
  async (input: Record<string, unknown>) => {
    const session = sessionFrom(input, "codex_view_image");
    if (session) { const out = runViewImage(session, input.path); traceResult(session, "codex_view_image", out); return out; }
    return jsonText({
      turn_token: input[turnKey],
      receipt: "V1: broker no implementado",
    });
  },
);

server.registerTool(
  "codex_tool_call",
  {
    title: "Call any tool from the current Codex harness",
    description: TOOL_DESCRIPTIONS.codex_tool_call,
    inputSchema: S.codex_tool_call,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async (input: Record<string, unknown>) => {
    const session = sessionFrom(input, "codex_tool_call");
    if (session) { const out = await runToolCall(session, input); traceResult(session, "codex_tool_call", out); return out; }
    return jsonText({
      turn_token: input[turnKey],
      wire_name: input.wire_name,
      executed: false,
      receipt: "V1: broker no implementado — la tool llega pero no ejecuta todavia",
    });
  },
);

registerMediaTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[codex-web-http MCP] contract=${contract} broker=${brokerSocketPath} sessions=${sandboxAvailable() ? "bwrap" : "no-bwrap"}`);
trace("startup", { pid: process.pid, contract, sandbox: sandboxAvailable() });
