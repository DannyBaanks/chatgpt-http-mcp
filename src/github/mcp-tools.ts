// src/github/mcp-tools.ts — Herramientas MCP de GitHub expuestas para invocación por modelos (ChatGPT, Claude, etc.).
import { z } from "zod";
import { callGitHubApi, dispatchWorkflow, runGhCli } from "./client";
import { resolveActiveGitHubToken } from "./tokens";

export const GITHUB_MCP_TOOLS = {
  github_api: {
    description: "Ejecuta cualquier llamada REST v3 o GraphQL oficial de GitHub autenticada con el token activo.",
    parameters: z.object({
      endpoint: z.string().describe("Endpoint de la API de GitHub (ej. /user, /repos/owner/repo/pulls)"),
      method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).optional().default("GET"),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async (args: {
      endpoint: string;
      method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      params?: Record<string, string | number | boolean>;
      body?: Record<string, unknown>;
    }) => {
      const res = await callGitHubApi(args.endpoint, {
        method: args.method || "GET",
        params: args.params,
        body: args.body,
      });
      return {
        ok: res.ok,
        status: res.status,
        data: res.data,
        error: res.error,
        rate_limit_remaining: res.rateLimitRemaining,
      };
    },
  },

  github_dispatch_workflow: {
    description: "Despacha un flujo de trabajo (workflow_dispatch) en GitHub Actions con inputs personalizados.",
    parameters: z.object({
      owner: z.string().describe("Dueño del repositorio u organización"),
      repo: z.string().describe("Nombre del repositorio"),
      workflow_id: z.string().describe("Nombre de archivo del workflow (ej. ci.yml) o ID numérico"),
      ref: z.string().optional().default("main").describe("Rama o tag sobre el cual ejecutar el flujo"),
      inputs: z.record(z.string(), z.unknown()).optional().describe("Parámetros de entrada para el workflow"),
    }),
    handler: async (args: {
      owner: string;
      repo: string;
      workflow_id: string;
      ref?: string;
      inputs?: Record<string, unknown>;
    }) => {
      const res = await dispatchWorkflow({
        owner: args.owner,
        repo: args.repo,
        workflowId: args.workflow_id,
        ref: args.ref || "main",
        inputs: args.inputs,
      });
      return {
        ok: res.ok,
        status: res.status,
        error: res.error,
        message: res.ok ? "Workflow despachado exitosamente (HTTP 204)" : res.error,
      };
    },
  },

  github_exec: {
    description: "Ejecuta un comando del CLI oficial de GitHub (gh) con la autenticación del token activo.",
    parameters: z.object({
      args: z.array(z.string()).describe("Argumentos para gh (ej. ['pr', 'list', '--state', 'open'])"),
    }),
    handler: async (args: { args: string[] }) => {
      const res = await runGhCli(args.args);
      return {
        ok: res.code === 0,
        exit_code: res.code,
        stdout: res.stdout,
        stderr: res.stderr,
      };
    },
  },

  github_status: {
    description: "Consulta el estado del token de GitHub activo, usuario conectado, scopes y límites de peticiones.",
    parameters: z.object({}),
    handler: async () => {
      const tokenInfo = await resolveActiveGitHubToken();
      if (!tokenInfo.token || tokenInfo.is_expired) {
        return {
          connected: false,
          reason: tokenInfo.is_expired ? "Token activo expirado" : "Sin token configurado",
          alias: tokenInfo.alias,
        };
      }
      const apiTest = await callGitHubApi<{ login: string; id: number; public_repos: number }>("/user");
      return {
        connected: apiTest.ok,
        user: apiTest.data?.login,
        scopes: tokenInfo.scopes,
        alias: tokenInfo.alias,
        source: tokenInfo.source,
        expires_at: tokenInfo.expires_at ? new Date(tokenInfo.expires_at).toISOString() : null,
        rate_limit_remaining: apiTest.rateLimitRemaining,
      };
    },
  },
};
