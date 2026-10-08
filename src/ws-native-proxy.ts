// ws-native-proxy.ts — reenvio de WebSocket NATIVO hacia el upstream de Codex.
//
// Codex App habla por WebSocket (ws://…/v1/responses) con TODOS los modelos.
// Con openai_base_url apuntando al bridge, los modelos nativos (gpt-6.1-sol,
// etc.) tambien llegan aqui. Antes se les respondia "solo modelos chatgpt-web/*"
// y la app se quedaba en "Reconectando" (visto 2026-10-07): por HTTP si se
// reenviaban (passthrough.ts), por WebSocket no.
//
// Aqui, por conexion: el primer mensaje nativo abre UN WebSocket al upstream
// con las cabeceras del handshake de la app (su propia autenticacion; el bridge
// no lee ni guarda credenciales) y desde ahi se reenvia en ambos sentidos. Lo
// que llega antes de que el upstream abra se encola. Cerrar un lado cierra el
// otro.

/** Cabeceras del handshake que NO se reenvian (las genera el cliente WS). */
const DROP = new Set([
  "host", "connection", "upgrade", "content-length", "origin",
  "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-accept",
  "x-isymcp-token",
]);

export function upstreamWsUrl(upstreamBase: string): string {
  return `${upstreamBase.replace(/^http/, "ws").replace(/\/+$/, "")}/responses`;
}

export function forwardHeaders(handshake: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(handshake)) {
    if (!DROP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/** Lo minimo del lado cliente que necesita el proxy (el ServerWebSocket de Bun). */
export interface ClientSide {
  send(data: string | ArrayBufferLike | Uint8Array): unknown;
  close(code?: number, reason?: string): unknown;
}

export class NativeWsProxy {
  private upstream: WebSocket | null = null;
  private queue: Array<string | ArrayBufferLike | Uint8Array> = [];
  private closed = false;

  constructor(
    private readonly client: ClientSide,
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  get active(): boolean {
    return this.upstream !== null;
  }

  /** Reenvia un mensaje del cliente; abre el upstream la primera vez. */
  send(data: string | ArrayBufferLike | Uint8Array): void {
    if (this.closed) return;
    if (!this.upstream) this.open();
    if (this.upstream!.readyState === WebSocket.OPEN) this.upstream!.send(data);
    else this.queue.push(data);
  }

  /** El cliente cerro: cerrar el upstream. */
  close(): void {
    this.closed = true;
    try { this.upstream?.close(); } catch { /* ya cerrado */ }
  }

  private open(): void {
    // Bun acepta cabeceras en el handshake del cliente WebSocket.
    const upstream = new WebSocket(this.url, { headers: this.headers } as unknown as string[]);
    upstream.binaryType = "arraybuffer";
    this.upstream = upstream;
    upstream.onopen = () => {
      for (const data of this.queue.splice(0)) upstream.send(data);
    };
    upstream.onmessage = (event) => {
      try { this.client.send(event.data as string | ArrayBuffer); } catch { /* cliente cerrado */ }
    };
    upstream.onclose = (event) => {
      if (this.closed) return;
      this.closed = true;
      // 1005/1006 no se pueden mandar explicitamente: se normaliza a 1011.
      const code = event.code === 1005 || event.code === 1006 ? 1011 : event.code;
      try { this.client.close(code, event.reason || "upstream cerrado"); } catch { /* ya cerrado */ }
    };
    upstream.onerror = () => {
      if (this.closed) return;
      try { this.client.send(JSON.stringify({ type: "error", error: { type: "upstream_ws_error", message: "no se pudo hablar con el upstream de Codex por WebSocket" } })); } catch { /* */ }
    };
  }
}
