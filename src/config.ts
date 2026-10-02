// config.ts — configuracion minima del server loopback.
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountCapabilities } from "./web-models";

export interface AppConfig {
  hostname: string;
  port: number;
  upstreamBase: string;
  webModels: "off" | "on";
  capabilities: AccountCapabilities;
  /** Timeout de la fase de headers del upstream (el stream no se corta por esto). */
  timeoutMs: number;
  /** Storage state de Playwright con la sesion de ChatGPT (0600, nunca en el repo). */
  browserStatePath: string;
  /** Binario del browser: chrome completo (sandbox) o headless shell. */
  browser: "chrome" | "shell";
  /** Ver el browser mientras se depura. */
  browserHeaded: boolean;
  /** Espera maxima por turno web antes de dar la respuesta por truncada. */
  webTurnDeadlineMs: number;
}

export const DEFAULT_PORT = 8791;
export const DEFAULT_UPSTREAM = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_STATE_PATH = join(homedir(), ".codex-web-http", "storage-state.json");
export const DEFAULT_WEB_TURN_DEADLINE_MS = 90_000;

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
  const timeoutRaw = env.CODEX_WEB_HTTP_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`CODEX_WEB_HTTP_TIMEOUT_MS invalido: ${timeoutRaw}`);
  }
  const browserRaw = (env.CODEX_WEB_HTTP_BROWSER?.trim() || "chrome").toLowerCase();
  if (browserRaw !== "chrome" && browserRaw !== "shell") {
    throw new Error(`CODEX_WEB_HTTP_BROWSER invalido: ${browserRaw} (chrome|shell)`);
  }
  const browserHeaded = (env.CODEX_WEB_HTTP_HEADED?.trim() || "").toLowerCase();
  if (browserHeaded !== "" && browserHeaded !== "1" && browserHeaded !== "0") {
    throw new Error(`CODEX_WEB_HTTP_HEADED invalido: ${browserHeaded} (1|0)`);
  }
  const deadlineRaw = env.CODEX_WEB_HTTP_WEB_TURN_DEADLINE_MS;
  const webTurnDeadlineMs = deadlineRaw ? Number(deadlineRaw) : DEFAULT_WEB_TURN_DEADLINE_MS;
  if (!Number.isInteger(webTurnDeadlineMs) || webTurnDeadlineMs <= 0) {
    throw new Error(`CODEX_WEB_HTTP_WEB_TURN_DEADLINE_MS invalido: ${deadlineRaw}`);
  }
  return {
    hostname: env.CODEX_WEB_HTTP_HOST?.trim() || "127.0.0.1",
    port,
    upstreamBase: (env.CODEX_WEB_HTTP_UPSTREAM?.trim() || DEFAULT_UPSTREAM).replace(/\/+$/, ""),
    webModels,
    capabilities: parseCapabilities(env.CODEX_WEB_HTTP_CAPS),
    timeoutMs,
    browserStatePath: env.CODEX_WEB_HTTP_STATE_PATH?.trim() || DEFAULT_STATE_PATH,
    browser: browserRaw,
    browserHeaded: browserHeaded === "1",
    webTurnDeadlineMs,
  };
}
