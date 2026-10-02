// config.ts — configuracion minima del server loopback.
export interface AppConfig {
  hostname: string;
  port: number;
  upstreamBase: string;
}

export const DEFAULT_PORT = 8791;
export const DEFAULT_UPSTREAM = "https://chatgpt.com/backend-api/codex";

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const portRaw = env.CODEX_WEB_HTTP_PORT;
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CODEX_WEB_HTTP_PORT invalido: ${portRaw}`);
  }
  return {
    hostname: env.CODEX_WEB_HTTP_HOST?.trim() || "127.0.0.1",
    port,
    upstreamBase: (env.CODEX_WEB_HTTP_UPSTREAM?.trim() || DEFAULT_UPSTREAM).replace(/\/+$/, ""),
  };
}
