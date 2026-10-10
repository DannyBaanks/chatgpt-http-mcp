// mcp-client.ts — cliente MCP stdio PERSISTENTE para los tests vivos.
//
// callMcpTool spawnea un server nuevo por llamada: para foreground esta bien,
// pero codex_write_stdin necesita que el exec_id viva en el MISMO proceso del
// server que ejecuto codex_exec background=true. Este cliente conecta una
// sola vez y correlaciona respuestas por id JSON-RPC.
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: unknown;
}

export class McpClient {
  private proc;
  private buf = "";
  private nextId = 2;
  private pending = new Map<number, (payload: Record<string, unknown>) => void>();

  private constructor(home: string, extraEnv: Record<string, string>) {
    this.proc = Bun.spawn(["bun", "src/mcp/main.ts", "--contract", "native"], {
      cwd: ROOT,
      env: { ...process.env, CODEX_WEB_HTTP_HOME: home, ...extraEnv },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          this.buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg: JsonRpcMessage;
            try {
              msg = JSON.parse(line) as JsonRpcMessage;
            } catch {
              continue;
            }
            if (msg.id !== undefined && this.pending.has(Number(msg.id))) {
              const resolve = this.pending.get(Number(msg.id))!;
              this.pending.delete(Number(msg.id));
              const text = msg.result?.content?.find((c) => c.type === "text")?.text;
              resolve(text ? (JSON.parse(text) as Record<string, unknown>) : { error: String(msg.error ?? "sin contenido") });
            }
          }
        }
      } catch {
        /* el server murio: los pending esperan al timeout del test */
      }
    })();
  }

  static async start(home: string, extraEnv: Record<string, string> = {}): Promise<McpClient> {
    const client = new McpClient(home, extraEnv);
    const initId = 1;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("initialize sin respuesta")), 15_000);
      client.pending.set(initId, () => {
        clearTimeout(timer);
        resolve();
      });
      client.send({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bun-test-persist", version: "0" } } });
    });
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return client;
  }

  private send(message: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    this.proc.stdin.flush();
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sin respuesta de ${tool}`)), 30_000);
      this.pending.set(id, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      this.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
    });
  }

  close(): void {
    try {
      this.proc.kill();
    } catch {
      /* ya muerto */
    }
  }
}
