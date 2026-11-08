// tests/chatgpt-plugin-package.test.ts — Pruebas de validación del paquete ChatGPT Private Plugin.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { packagePlugin, computeSha256 } from "../scripts/package-chatgpt-plugin";
import { startPanel } from "../src/panel";

const REPO_ROOT = join(import.meta.dir, "..");

describe("ChatGPT Private Plugin Packaging & Spec Compliance", () => {
  test("ai-plugin.json cumple con la especificación oficial de OpenAI", () => {
    const manifestPath = join(REPO_ROOT, "plugin", ".well-known", "ai-plugin.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.schema_version).toBe("v1");
    expect(manifest.name_for_human).toBe("ISyMCP Control Center");
    expect(manifest.name_for_model).toBe("isymcp_control_center");
    expect(typeof manifest.description_for_human).toBe("string");
    expect(typeof manifest.description_for_model).toBe("string");
    expect(manifest.auth.type).toBe("none");
    expect(manifest.api.type).toBe("openapi");
    expect(manifest.api.url).toContain("/openapi.json");
    expect(manifest.logo_url).toContain("/plugin-logo.png");
    expect(manifest.legal_info_url).toContain("/legal");
  });

  test("openapi.json es una especificación válida OpenAPI 3.1 con todos los endpoints del Control Center", () => {
    const openapiPath = join(REPO_ROOT, "plugin", "openapi.json");
    expect(existsSync(openapiPath)).toBe(true);

    const schema = JSON.parse(readFileSync(openapiPath, "utf8"));
    expect(schema.openapi).toBe("3.1.0");
    expect(schema.info.title).toContain("ISyMCP Control Center");
    expect(schema.paths).toBeDefined();

    // Endpoints requeridos por el Control Center
    expect(schema.paths["/api/control-center/overview"]?.get).toBeDefined();
    expect(schema.paths["/api/control-center/glossary"]?.get).toBeDefined();
    expect(schema.paths["/api/control-center/tasks"]?.get).toBeDefined();
    expect(schema.paths["/api/control-center/tasks/approve"]?.post).toBeDefined();
    expect(schema.paths["/api/control-center/protocol"]?.get).toBeDefined();
    expect(schema.paths["/api/control-center/cli"]?.post).toBeDefined();
    expect(schema.paths["/api/control-center/dispatch"]?.post).toBeDefined();

    // Verificación de esquemas en components
    expect(schema.components?.schemas?.ControlCenterOverview).toBeDefined();
    expect(schema.components?.schemas?.CliExecutionRequest).toBeDefined();
    expect(schema.components?.schemas?.CliExecutionResult).toBeDefined();
    expect(schema.components?.schemas?.ControlCenterTaskItem).toBeDefined();
  });

  test("plugin-logo.png existe y es una imagen PNG válida de al menos 10KB", () => {
    const logoPath = join(REPO_ROOT, "plugin", "plugin-logo.png");
    expect(existsSync(logoPath)).toBe(true);

    const buf = readFileSync(logoPath);
    expect(buf.byteLength).toBeGreaterThan(10000);
    // Verificación de la firma PNG: 89 50 4E 47 0D 0A 1A 0A
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  test("packagePlugin() genera el ZIP y SHA256SUMS.txt con cero fugas de secretos", () => {
    const result = packagePlugin(REPO_ROOT);
    expect(result.ok).toBe(true);
    expect(existsSync(result.zipPath)).toBe(true);

    const shaSumsPath = join(REPO_ROOT, "dist", "SHA256SUMS.txt");
    expect(existsSync(shaSumsPath)).toBe(true);

    const shaSumsContent = readFileSync(shaSumsPath, "utf8");
    expect(shaSumsContent).toContain(result.sha256);
    expect(shaSumsContent).toContain("isymcp-chatgpt-plugin.zip");

    // Verificar contenido del ZIP inspeccionando con zipinfo/unzip -l
    const checkZip = spawnSync("unzip", ["-l", result.zipPath], { encoding: "utf8" });
    expect(checkZip.status).toBe(0);
    const output = checkZip.stdout;

    expect(output).toContain(".well-known/ai-plugin.json");
    expect(output).toContain("openapi.json");
    expect(output).toContain("plugin-logo.png");
    expect(output).toContain("metadata.json");
    expect(output).toContain("README.md");

    // Aislamiento: cero tokens, secrets o bases de datos en el ZIP
    expect(output).not.toContain(".env");
    expect(output).not.toContain(".sqlite");
    expect(output).not.toContain("token");
    expect(output).not.toContain("secret");
    expect(output).not.toContain(".key");
  });
});

describe("Panel Server ChatGPT Plugin Endpoints & CORS", () => {
  let server: ReturnType<typeof startPanel>;
  const testPort = 18798;
  const baseUrl = `http://127.0.0.1:${testPort}`;

  beforeAll(() => {
    server = startPanel(testPort, "18791");
  });

  afterAll(() => {
    server.stop(true);
  });

  test("GET /.well-known/ai-plugin.json responde 200 con JSON, CORS y URLs dinámicas", async () => {
    const res = await fetch(`${baseUrl}/.well-known/ai-plugin.json`, {
      headers: { Host: `127.0.0.1:${testPort}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const json = await res.json();
    expect(json.schema_version).toBe("v1");
    expect(json.api.url).toBe(`${baseUrl}/openapi.json`);
    expect(json.logo_url).toBe(`${baseUrl}/plugin-logo.png`);
    expect(json.legal_info_url).toBe(`${baseUrl}/legal`);
  });

  test("GET /openapi.json responde 200 con especificación OpenAPI y server URL dinámico", async () => {
    const res = await fetch(`${baseUrl}/openapi.json`, {
      headers: { Host: `127.0.0.1:${testPort}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const json = await res.json();
    expect(json.openapi).toBe("3.1.0");
    expect(json.servers[0].url).toBe(baseUrl);
    expect(json.paths["/api/control-center/overview"]).toBeDefined();
  });

  test("GET /plugin-logo.png responde 200 con image/png", async () => {
    const res = await fetch(`${baseUrl}/plugin-logo.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(10000);
  });

  test("GET /legal responde 200 con aviso legal", async () => {
    const res = await fetch(`${baseUrl}/legal`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("ISyMCP Control Center");
  });

  test("OPTIONS responde 204 con cabeceras CORS para plugin y API", async () => {
    const optPlugin = await fetch(`${baseUrl}/.well-known/ai-plugin.json`, { method: "OPTIONS" });
    expect(optPlugin.status).toBe(204);
    expect(optPlugin.headers.get("access-control-allow-origin")).toBe("*");

    const optApi = await fetch(`${baseUrl}/api/control-center/overview`, { method: "OPTIONS" });
    expect(optApi.status).toBe(204);
    expect(optApi.headers.get("access-control-allow-origin")).toBe("*");
  });
});
