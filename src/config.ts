// config.ts — configuracion minima del server loopback.
import type { AccountCapabilities } from "./web-models";

export interface AppConfig {
  hostname: string;
  port: number;
  upstreamBase: string;
  webModels: "off" | "on";
  capabilities: AccountCapabilities;
}

export const DEFAULT_PORT = 8791;
export const DEFAULT_UPSTREAM = "https://chatgpt.com/backend-api/codex";

/** Caps por entorno: "sol,extrahigh,pro,bigger". Default conservador: sol. */
export function parseCapabilities(raw: string | undefined): AccountCapabilities {
  const parts = new Set(
    (raw ?? "sol")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  return {
    solAvailable: parts.has("sol"),
    extraHighAvailable: parts.has("extrahigh"),
    proAvailable: parts.has("pro"),
    biggerContext: parts.has("bigger"),
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const portRaw = env.CODEX_WEB_HTTP_PORT;
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CODEX_WEB_HTTP_PORT invalido: ${portRaw}`);
  }
  const webModels = (env.CODEX_WEB_HTTP_WEB_MODELS?.trim() || "off").toLowerCase();
  if (webModels !== "off" && webModels !== "on") {
    throw new Error(`CODEX_WEB_HTTP_WEB_MODELS invalido: ${webModels} (off|on)`);
  }
  return {
    hostname: env.CODEX_WEB_HTTP_HOST?.trim() || "127.0.0.1",
    port,
    upstreamBase: (env.CODEX_WEB_HTTP_UPSTREAM?.trim() || DEFAULT_UPSTREAM).replace(/\/+$/, ""),
    webModels,
    capabilities: parseCapabilities(env.CODEX_WEB_HTTP_CAPS),
  };
}
