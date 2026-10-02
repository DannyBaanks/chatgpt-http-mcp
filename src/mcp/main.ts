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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildInstructions } from "./identity";

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
  version: "0.2.0",
}, {
  instructions: buildInstructions(contract),
});

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
    if (!token) return { content: [{ type: "text", text: `${turnKey} requerido` }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify({ started: true, turn_token: token }) }],
    };
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
    if (!token) return { content: [{ type: "text", text: `${turnKey} requerido` }], isError: true };
    const command = input.command as string[];
    return {
      content: [{ type: "text", text: JSON.stringify({
        turn_token: token,
        requested: command,
        receipt: "V1: broker no implementado; comando recibido y registrado",
        executed: false,
        stdout: "",
        stderr: "broker not connected (V1 stub)",
        exit_code: null,
      }) }],
    };
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
      return { content: [{ type: "text", text: `${turnKey} y response requeridos` }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ completed: true, turn_token: token }) }],
    };
  },
);

server.registerTool(
  "codex_tool_inventory",
  {
    description: "Lista las tools disponibles en el runtime conectado.",
    inputSchema: { [turnKey]: turnTokenSchema },
  },
  async () => ({
    content: [{ type: "text", text: JSON.stringify({
      tools: ["codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image"],
      source: "codex-web-http V1 stub",
    }) }],
  }),
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
  async (input: Record<string, unknown>) => ({
    content: [{ type: "text", text: JSON.stringify({
      turn_token: input[turnKey],
      receipt: "V1: broker no implementado",
    }) }],
  }),
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
  async (input: Record<string, unknown>) => ({
    content: [{ type: "text", text: JSON.stringify({
      turn_token: input[turnKey],
      receipt: "V1: broker no implementado",
    }) }],
  }),
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
  async (input: Record<string, unknown>) => ({
    content: [{ type: "text", text: JSON.stringify({
      turn_token: input[turnKey],
      receipt: "V1: broker no implementado",
    }) }],
  }),
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
  async (input: Record<string, unknown>) => ({
    content: [{ type: "text", text: JSON.stringify({
      turn_token: input[turnKey],
      wire_name: input.wire_name,
      executed: false,
      receipt: "V1: broker no implementado — la tool llega pero no ejecuta todavia",
    }) }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[codex-web-http MCP] contract=${contract} broker=${brokerSocketPath} (stub V1)`);
