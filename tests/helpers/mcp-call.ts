// mcp-call.ts — llama una tool del MCP stdio real (bun src/mcp/main.ts) y
// devuelve el JSON del primer bloque de texto. Compartido por los tests vivos.
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export async function callMcpTool(
  home: string,
  tool: string,
  args: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["bun", "src/mcp/main.ts", "--contract", "native"], {
    cwd: ROOT,
    env: { ...process.env, CODEX_WEB_HTTP_HOME: home, ...extraEnv },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (message: Record<string, unknown>) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bun-test", version: "0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });

  // Sin Promise.race por iteracion: filtraria un read() pendiente y con
  // respuestas lentas el dato resuelve el read filtrado (visto 2026-10-06).
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const readUntil = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('"id":2')) return;
    }
  })();
  await Promise.race([readUntil, new Promise((resolve) => setTimeout(resolve, 30_000))]);
  proc.kill();
  await proc.exited;

  const line = buf.split("\n").find((l) => l.includes('"id":2'));
  if (!line) throw new Error(`sin respuesta tools/call. stdout=${buf.slice(0, 500)}`);
  const message = JSON.parse(line) as { result?: { content?: Array<{ type: string; text?: string }> } };
  const text = message.result?.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error(`respuesta sin texto: ${line.slice(0, 500)}`);
  return JSON.parse(text) as Record<string, unknown>;
}
