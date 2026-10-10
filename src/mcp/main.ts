// src/mcp/main.ts — entry point del servidor MCP stdio para el túnel.
//
// Protocolo: Model Context Protocol sobre stdio (lo que tunnel-client espera
// como --mcp-command). Expone las 8 tools del Codex GPT MCP (contrato native)
// que ChatGPT invoca en un turno. V1: las tools responden con receipts sin
// broker real; el broker se agrega cuando exista el turn dispatcher.
//
// El nombre publico del app ("Codex ISyMCP"), el token @CODEX ISYMCP y las
// instructions viven en ./identity.ts — un solo lugar, para que la pagina y el
// server no puedan divergir.
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
import { buildInstructions } from "./identity";
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
const turnTokenSchema = z.string().min(20).max(256);

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

async function runExec(session: CodexSession, command: unknown, cwdArg: unknown) {
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
    return fail("formato *** Begin Patch no soportado en v0; usa diff unificado (git diff)", { session: sessionMeta(session) });
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

server.registerTool(
  "codex_turn_start",
  {
    description: "Inicia un turno Codex. Devuelve el turn_token para las demas tools.",
    inputSchema: contract === "safe"
      ? { request_id: turnTokenSchema }
      : { turn_token: turnTokenSchema },
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
    description: "Ejecuta un comando en el runtime Codex.",
    inputSchema: {
      [turnKey]: turnTokenSchema,
      command: z.array(z.string()),
      cwd: z.string().optional(),
    },
  },
  async (input: Record<string, unknown>) => {
    const token = String(input[turnKey] ?? "");
    if (!token) return fail(`${turnKey} requerido`);
    const session = sessionFrom(input, "codex_exec");
    if (session) { const out = await runExec(session, input.command, input.cwd); traceResult(session, "codex_exec", out); return out; }
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
    description: "Envia la respuesta completa al turno conectado.",
    inputSchema: {
      [turnKey]: turnTokenSchema,
      response: z.string(),
    },
  },
  async (input: Record<string, unknown>) => {
    const token = String(input[turnKey] ?? "");
    const response = String(input.response ?? "");
    if (!token || !response) {
      return fail(`${turnKey} y response requeridos`);
    }
    const session = sessionFrom(input, "codex_turn_complete");
    if (session) return jsonText({ completed: true, session: sessionMeta(session) });
    return jsonText({ completed: true, turn_token: token });
  },
);

server.registerTool(
  "codex_tool_inventory",
  {
    description: "Lista las tools disponibles en el runtime conectado.",
    inputSchema: { [turnKey]: turnTokenSchema },
  },
  async (input: Record<string, unknown>) => {
    const session = sessionFrom(input, "codex_tool_inventory");
    if (session) {
      traceResult(session, "codex_tool_inventory", jsonText({ executed: true }));
      return jsonText({
        session: sessionMeta(session),
        tools: ["codex_exec", "codex_apply_patch", "codex_view_image", "codex_tool_inventory", "codex_turn_start", "codex_turn_complete"],
        source: "codex-web-http sessions",
        sandbox: sandboxAvailable() ? "bwrap" : "none",
      });
    }
    return jsonText({
      tools: ["codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image"],
      source: "codex-web-http V1 stub",
    });
  },
);

server.registerTool(
  "codex_write_stdin",
  {
    description: "Escribe al stdin de un proceso en ejecucion.",
    inputSchema: {
      [turnKey]: turnTokenSchema,
      exec_id: z.string(),
      data: z.string(),
    },
  },
  async (input: Record<string, unknown>) => {
    const session = sessionFrom(input, "codex_write_stdin");
    if (session) {
      return jsonText({
        session: sessionMeta(session),
        executed: false,
        receipt: "write_stdin no implementado en v0 (no hay registro de procesos)",
      });
    }
    return jsonText({
      turn_token: input[turnKey],
      receipt: "V1: broker no implementado",
    });
  },
);

server.registerTool(
  "codex_apply_patch",
  {
    description: "Aplica un patch diff a un archivo.",
    inputSchema: {
      [turnKey]: turnTokenSchema,
      patch: z.string(),
    },
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
    description: "Devuelve una imagen para inspeccion del modelo.",
    inputSchema: {
      [turnKey]: turnTokenSchema,
      path: z.string(),
    },
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
    description: [
      "Invoke an exact wire_name returned by codex_tool_inventory.",
      "El harness Codex externo ejecuta la llamada, las aprobaciones y el ciclo de vida.",
    ].join(" "),
    inputSchema: {
      [turnKey]: turnTokenSchema,
      wire_name: z.string().min(1).max(1_000),
      arguments: z.record(z.string(), z.unknown()).optional(),
      input: z.string().max(5_000_000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async (input: Record<string, unknown>) => {
    const session = sessionFrom(input, "codex_tool_call");
    if (session) {
      return jsonText({
        session: sessionMeta(session),
        wire_name: input.wire_name,
        executed: false,
        receipt: "tool_call no implementado en v0; usa codex_exec/codex_apply_patch/codex_view_image",
      });
    }
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
