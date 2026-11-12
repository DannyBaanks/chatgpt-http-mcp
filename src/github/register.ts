// src/github/register.ts — Registro de herramientas MCP de GitHub en el servidor McpServer.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callGitHubApi, dispatchWorkflow } from "./client";
import { GITHUB_MCP_TOOLS } from "./mcp-tools";
import { resolveActiveGitHubToken } from "./tokens";

function jsonText(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function registerGitHubTools(server: McpServer): void {
  server.registerTool(
    "github_status",
    {
      description:
        "Consulta el estado del token de GitHub activo en ISyMCP: usuario (@DannyBaanks), scopes autorizados, expiración y límite de peticiones de API.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const tokenInfo = await resolveActiveGitHubToken();
      if (!tokenInfo.token || tokenInfo.is_expired) {
        return jsonText({
          connected: false,
          reason: tokenInfo.is_expired ? "Token activo expirado" : "Sin token configurado",
          alias: tokenInfo.alias,
        });
      }
      const test = await callGitHubApi<{ login: string; id: number; public_repos: number }>("/user");
      return jsonText({
        connected: test.ok,
        user: test.data?.login,
        scopes: tokenInfo.scopes,
        alias: tokenInfo.alias,
        source: tokenInfo.source,
        expires_at: tokenInfo.expires_at ? new Date(tokenInfo.expires_at).toISOString() : null,
        rate_limit_remaining: test.rateLimitRemaining,
      });
    }
  );

  server.registerTool(
    "github_api",
    {
      description:
        "Ejecuta cualquier llamada REST v3 o GraphQL oficial de GitHub autenticada con el token activo. Permite consultar o modificar repositorios, commits, ramas, releases, issues o pull requests según los permisos autorizados.",
      inputSchema: {
        endpoint: z.string().describe("Endpoint de la API de GitHub (ej. /user/repos, /repos/owner/repo/pulls)"),
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).optional().describe("Método HTTP (GET por defecto)"),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query parameters de URL"),
        body: z.record(z.string(), z.unknown()).optional().describe("Cuerpo JSON para peticiones POST/PATCH/PUT"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    // Misma lógica que el gateway (política + marca de contaminación): un solo lugar, mcp-tools.ts.
    async (args) => jsonText(await GITHUB_MCP_TOOLS.github_api.handler(args as Parameters<typeof GITHUB_MCP_TOOLS.github_api.handler>[0])),
  );

  server.registerTool(
    "github_dispatch_workflow",
    {
      description:
        "Despacha un flujo de trabajo (workflow_dispatch) de GitHub Actions en cualquier repositorio con inputs y rama personalizados.",
      inputSchema: {
        owner: z.string().describe("Dueño del repositorio u organización"),
        repo: z.string().describe("Nombre del repositorio"),
        workflow_id: z.string().describe("Nombre de archivo del workflow (ej. ci.yml) o ID numérico"),
        ref: z.string().optional().describe("Rama o tag sobre el cual ejecutar el flujo (por defecto 'main')"),
        inputs: z.record(z.string(), z.unknown()).optional().describe("Inputs JSON requeridos por el workflow"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const res = await dispatchWorkflow({
        owner: args.owner,
        repo: args.repo,
        workflowId: args.workflow_id,
        ref: args.ref || "main",
        inputs: args.inputs,
      });
      return jsonText({
        ok: res.ok,
        status: res.status,
        error: res.error,
        message: res.ok ? "Workflow despachado exitosamente (HTTP 204)" : res.error,
      });
    }
  );

  server.registerTool(
    "github_exec",
    {
      description:
        "Ejecuta un comando del CLI oficial de GitHub (gh) en el sistema local con el token y permisos de DannyBaanks inyectados.",
      inputSchema: {
        args: z.array(z.string()).describe("Argumentos para gh (ej. ['pr', 'list', '--state', 'open'])"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => jsonText(await GITHUB_MCP_TOOLS.github_exec.handler(args)),
  );
}
