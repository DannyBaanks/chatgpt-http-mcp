// src/github/client.ts — Cliente para interactuar con la API oficial y CLI de GitHub usando tokens autorizados.
import { resolveActiveGitHubToken } from "./tokens";
import { spawn } from "node:child_process";

export interface GitHubApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  rateLimitRemaining?: number;
}

/**
 * Realiza una llamada HTTP autenticada a la API de GitHub v3 (REST) o GraphQL.
 */
export async function callGitHubApi<T = unknown>(
  endpoint: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    body?: unknown;
    params?: Record<string, string | number | boolean>;
    customToken?: string;
  } = {}
): Promise<GitHubApiResponse<T>> {
  let token = options.customToken;
  if (!token) {
    const resolved = await resolveActiveGitHubToken();
    if (!resolved.token || resolved.is_expired) {
      return {
        ok: false,
        status: 401,
        error: resolved.is_expired
          ? `El token activo (${resolved.alias}) ha expirado. Usa 'isymcp github tokens' para renovarlo o seleccionar otro.`
          : "No hay ningún token de GitHub activo ni configurado. Usa 'isymcp github tokens wizard' o 'gh auth login'.",
      };
    }
    token = resolved.token;
  }

  const method = options.method || "GET";
  let urlStr = endpoint.startsWith("https://") ? endpoint : `https://api.github.com${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;

  if (options.params && Object.keys(options.params).length > 0) {
    const url = new URL(urlStr);
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
    urlStr = url.toString();
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "User-Agent": "ISyMCP-GitHub-Engine/1.0",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    let bodyStr: string | undefined = undefined;
    if (options.body && method !== "GET") {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(options.body);
    }

    const res = await fetch(urlStr, {
      method,
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(30_000),
    });

    const rateLimitRemaining = Number(res.headers.get("x-ratelimit-remaining") ?? "0");

    let responseData: unknown = null;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      responseData = await res.json();
    } else {
      responseData = await res.text();
    }

    if (!res.ok) {
      let errMsg = `GitHub API Error ${res.status} ${res.statusText}`;
      if (responseData && typeof responseData === "object" && "message" in responseData) {
        errMsg = String((responseData as { message: unknown }).message);
      }
      return {
        ok: false,
        status: res.status,
        error: errMsg,
        rateLimitRemaining,
      };
    }

    return {
      ok: true,
      status: res.status,
      data: responseData as T,
      rateLimitRemaining,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Ejecuta un comando `gh` en el sistema inyectando de forma segura el token activo en el entorno.
 */
export async function runGhCli(
  args: string[],
  options: { cwd?: string; timeoutMs?: number; customToken?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  let token = options.customToken;
  if (!token) {
    const resolved = await resolveActiveGitHubToken();
    token = resolved.token || undefined;
  }

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
    };

    const proc = spawn("gh", args, {
      cwd: options.cwd || process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      stderr += "\n[TIMEOUT] El comando gh excedió el límite de tiempo asignado.";
    }, options.timeoutMs ?? 30_000);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ code: 127, stdout: "", stderr: `Error al iniciar gh: ${err.message}` });
    });
  });
}

/**
 * Despacha un GitHub Action workflow mediante `workflow_dispatch`.
 */
export async function dispatchWorkflow(options: {
  owner: string;
  repo: string;
  workflowId: string;
  ref: string;
  inputs?: Record<string, unknown>;
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const endpoint = `/repos/${options.owner}/${options.repo}/actions/workflows/${options.workflowId}/dispatches`;
  const res = await callGitHubApi(endpoint, {
    method: "POST",
    body: {
      ref: options.ref,
      inputs: options.inputs || {},
    },
  });
  return {
    ok: res.ok,
    status: res.status,
    error: res.error,
  };
}
