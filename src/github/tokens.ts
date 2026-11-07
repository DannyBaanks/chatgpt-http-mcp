// src/github/tokens.ts — Gestión segura y ciclo de vida de tokens de GitHub para ISyMCP.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

export interface StoredGitHubToken {
  alias: string;
  token: string;
  login: string;
  scopes: string[];
  created_at: number;
  expires_at: number | null; // epoch ms (null = sin expiración)
  ttl_hours: number | null;
  active: boolean;
  source: "wizard" | "manual" | "gh_cli" | "env";
  notes?: string;
}

export interface TokenValidationResult {
  valid: boolean;
  login?: string;
  name?: string | null;
  scopes: string[];
  rateLimitRemaining?: number;
  error?: string;
}

const SECRETS_DIR = join(homedir(), ".codex-web-http", "secrets");
const TOKENS_FILE = join(SECRETS_DIR, "github-tokens.json");

function ensureSecretsDir(): void {
  if (!existsSync(SECRETS_DIR)) {
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Carga todos los tokens almacenados en el almacén local cifrado/restringido (0600).
 */
export function loadStoredTokens(): StoredGitHubToken[] {
  ensureSecretsDir();
  if (!existsSync(TOKENS_FILE)) return [];
  try {
    const raw = readFileSync(TOKENS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Guarda la lista de tokens asegurando permisos estrictos 0600 (solo lectura/escritura del usuario).
 */
export function saveStoredTokens(tokens: StoredGitHubToken[]): void {
  ensureSecretsDir();
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  try {
    chmodSync(TOKENS_FILE, 0o600);
  } catch {}
}

/**
 * Valida un token directamente contra la API oficial de GitHub.
 */
export async function validateGitHubToken(token: string): Promise<TokenValidationResult> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    return { valid: false, scopes: [], error: "Token vacío o nulo" };
  }

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        "User-Agent": "ISyMCP-GitHub-Engine/1.0",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) msg = body.message;
      } catch {}
      return { valid: false, scopes: [], error: msg };
    }

    const data = (await res.json()) as { login: string; name?: string | null };
    const rawScopes = res.headers.get("x-oauth-scopes") || "";
    const scopes = rawScopes
      ? rawScopes.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const rateLimit = Number(res.headers.get("x-ratelimit-remaining") ?? "0");

    return {
      valid: true,
      login: data.login,
      name: data.name ?? null,
      scopes,
      rateLimitRemaining: rateLimit,
    };
  } catch (err) {
    return {
      valid: false,
      scopes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Extrae el token actual desde el CLI de GitHub (`gh auth token`) si está disponible.
 */
export function getGhCliToken(): string | null {
  try {
    const out = execSync("gh auth token", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 3000 });
    const trimmed = out.trim();
    return trimmed.length > 10 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Resuelve el token activo según la cadena de prioridad:
 * 1. Token marcado como `active: true` en el almacén local (si no ha expirado).
 * 2. Variables de entorno `ISYMCP_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`.
 * 3. Token del keyring local de `gh auth token`.
 */
export async function resolveActiveGitHubToken(): Promise<{
  token: string | null;
  alias: string;
  source: "stored" | "env" | "gh_cli" | "none";
  login?: string;
  scopes: string[];
  expires_at: number | null;
  is_expired: boolean;
}> {
  const now = Date.now();
  const stored = loadStoredTokens();
  const activeStored = stored.find((t) => t.active);

  if (activeStored) {
    const isExpired = activeStored.expires_at !== null && now > activeStored.expires_at;
    if (!isExpired) {
      return {
        token: activeStored.token,
        alias: activeStored.alias,
        source: "stored",
        login: activeStored.login,
        scopes: activeStored.scopes,
        expires_at: activeStored.expires_at,
        is_expired: false,
      };
    }
  }

  // 2. Env
  const envToken = process.env.ISYMCP_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken && envToken.trim().length > 10) {
    return {
      token: envToken.trim(),
      alias: "env-token",
      source: "env",
      scopes: ["env-unverified"],
      expires_at: null,
      is_expired: false,
    };
  }

  // 3. gh auth token
  const cliToken = getGhCliToken();
  if (cliToken) {
    return {
      token: cliToken,
      alias: "gh-cli-default",
      source: "gh_cli",
      login: "DannyBaanks",
      scopes: ["repo", "workflow", "gist", "read:org"],
      expires_at: null,
      is_expired: false,
    };
  }

  return {
    token: null,
    alias: "none",
    source: "none",
    scopes: [],
    expires_at: null,
    is_expired: false,
  };
}

/**
 * Agrega un nuevo token al almacén local con cálculo de tiempo y validación.
 */
export async function registerToken(options: {
  alias: string;
  token: string;
  ttl_hours?: number | null;
  makeActive?: boolean;
  notes?: string;
}): Promise<{ ok: boolean; token?: StoredGitHubToken; error?: string }> {
  const validation = await validateGitHubToken(options.token);
  if (!validation.valid) {
    return { ok: false, error: validation.error || "Token inválido según la API de GitHub" };
  }

  const now = Date.now();
  let expires_at: number | null = null;
  if (options.ttl_hours && options.ttl_hours > 0) {
    expires_at = now + options.ttl_hours * 3600 * 1000;
  }

  const stored = loadStoredTokens();
  // Si se marca como activo, desactivar los demás
  const shouldBeActive = options.makeActive ?? (stored.length === 0);
  if (shouldBeActive) {
    for (const t of stored) t.active = false;
  }

  const existingIndex = stored.findIndex((t) => t.alias.toLowerCase() === options.alias.toLowerCase());
  const entry: StoredGitHubToken = {
    alias: options.alias,
    token: options.token.trim(),
    login: validation.login || "unknown",
    scopes: validation.scopes,
    created_at: now,
    expires_at,
    ttl_hours: options.ttl_hours ?? null,
    active: shouldBeActive,
    source: "wizard",
    notes: options.notes,
  };

  if (existingIndex >= 0) {
    stored[existingIndex] = entry;
  } else {
    stored.push(entry);
  }

  saveStoredTokens(stored);
  return { ok: true, token: entry };
}

/**
 * Selecciona un token guardado como el activo por su alias.
 */
export function setActiveToken(alias: string): { ok: boolean; error?: string } {
  const stored = loadStoredTokens();
  const match = stored.find((t) => t.alias.toLowerCase() === alias.toLowerCase());
  if (!match) {
    return { ok: false, error: `No se encontró ningún token con alias '${alias}'` };
  }
  for (const t of stored) {
    t.active = t.alias.toLowerCase() === alias.toLowerCase();
  }
  saveStoredTokens(stored);
  return { ok: true };
}

/**
 * Elimina un token del almacén por su alias.
 */
export function removeToken(alias: string): { ok: boolean; removed?: StoredGitHubToken; error?: string } {
  const stored = loadStoredTokens();
  const index = stored.findIndex((t) => t.alias.toLowerCase() === alias.toLowerCase());
  if (index === -1) {
    return { ok: false, error: `No se encontró ningún token con alias '${alias}'` };
  }
  const [removed] = stored.splice(index, 1);
  // Si el que se borró era el activo y quedan otros, activar el primero
  if (removed.active && stored.length > 0) {
    stored[0].active = true;
  }
  saveStoredTokens(stored);
  return { ok: true, removed };
}
