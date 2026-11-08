// scripts/package-chatgpt-plugin.ts — Empaquetador y validador del plugin privado de ChatGPT para ISyMCP.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface PackageResult {
  ok: boolean;
  zipPath: string;
  sha256: string;
  files: { name: string; sha256: string; size: number }[];
  error?: string;
}

export function computeSha256(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

export function validatePluginFiles(pluginDir: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  const manifestPath = join(pluginDir, ".well-known", "ai-plugin.json");
  if (!existsSync(manifestPath)) {
    errors.push(`Manifiesto faltante: ${manifestPath}`);
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.schema_version !== "v1") errors.push("schema_version debe ser 'v1'");
      if (!manifest.name_for_human) errors.push("name_for_human es requerido");
      if (!manifest.name_for_model) errors.push("name_for_model es requerido");
      if (!manifest.api?.url) errors.push("api.url es requerido");
      if (!manifest.auth?.type) errors.push("auth.type es requerido");
    } catch (e: any) {
      errors.push(`Error al parsear ${manifestPath}: ${e.message}`);
    }
  }

  const openapiPath = join(pluginDir, "openapi.json");
  if (!existsSync(openapiPath)) {
    errors.push(`OpenAPI schema faltante: ${openapiPath}`);
  } else {
    try {
      const openapi = JSON.parse(readFileSync(openapiPath, "utf8"));
      if (!openapi.openapi?.startsWith("3.")) errors.push("openapi version debe ser 3.x");
      if (!openapi.info?.title) errors.push("info.title es requerido");
      if (!openapi.paths || Object.keys(openapi.paths).length === 0) errors.push("paths no puede estar vacío");
    } catch (e: any) {
      errors.push(`Error al parsear ${openapiPath}: ${e.message}`);
    }
  }

  const logoPath = join(pluginDir, "plugin-logo.png");
  if (!existsSync(logoPath)) {
    errors.push(`Logo faltante: ${logoPath}`);
  } else {
    const size = readFileSync(logoPath).byteLength;
    if (size < 100) errors.push("Logo corrupto o demasiado pequeño");
  }

  return { ok: errors.length === 0, errors };
}

export function packagePlugin(repoRoot: string): PackageResult {
  const pluginDir = resolve(repoRoot, "plugin");
  const distDir = resolve(repoRoot, "dist");
  const stageDir = resolve(distDir, "plugin");
  const zipPath = resolve(distDir, "isymcp-chatgpt-plugin.zip");
  const shaSumsPath = resolve(distDir, "SHA256SUMS.txt");

  const validation = validatePluginFiles(pluginDir);
  if (!validation.ok) {
    return {
      ok: false,
      zipPath: "",
      sha256: "",
      files: [],
      error: `Validación fallida: ${validation.errors.join("; ")}`,
    };
  }

  mkdirSync(stageDir, { recursive: true });
  mkdirSync(join(stageDir, ".well-known"), { recursive: true });

  const filesToCopy = [
    { src: join(pluginDir, ".well-known", "ai-plugin.json"), dest: join(stageDir, ".well-known", "ai-plugin.json"), rel: ".well-known/ai-plugin.json" },
    { src: join(pluginDir, "openapi.json"), dest: join(stageDir, "openapi.json"), rel: "openapi.json" },
    { src: join(pluginDir, "plugin-logo.png"), dest: join(stageDir, "plugin-logo.png"), rel: "plugin-logo.png" },
    { src: join(pluginDir, "metadata.json"), dest: join(stageDir, "metadata.json"), rel: "metadata.json" },
    { src: join(pluginDir, "README.md"), dest: join(stageDir, "README.md"), rel: "README.md" },
  ];

  for (const f of filesToCopy) {
    if (existsSync(f.src)) {
      writeFileSync(f.dest, readFileSync(f.src));
    }
  }

  if (existsSync(zipPath)) {
    rmSync(zipPath);
  }

  // GNU zip on POSIX; Windows ships BSD tar with ZIP writer support (-a).
  // Both package exact staged entries and include the hidden .well-known folder.
  const entries = [".well-known", "openapi.json", "plugin-logo.png", "metadata.json", "README.md"];
  const zipCmd = process.platform === "win32"
    ? spawnSync("tar.exe", ["-a", "-c", "-f", zipPath, ...entries], { cwd: stageDir, encoding: "utf8" })
    : spawnSync("zip", ["-r", zipPath, ...entries], { cwd: stageDir, encoding: "utf8" });

  if (zipCmd.status !== 0) {
    return {
      ok: false,
      zipPath: "",
      sha256: "",
      files: [],
      error: `Error al crear archivo zip: ${zipCmd.stderr || zipCmd.stdout}`,
    };
  }

  const zipSha = computeSha256(zipPath);
  const fileSummaries = filesToCopy.map((f) => {
    const s = computeSha256(f.dest);
    const size = readFileSync(f.dest).byteLength;
    return { name: f.rel, sha256: s, size };
  });

  const shaSumsLines = [
    `# ISyMCP ChatGPT Private Plugin Checksums`,
    `# Generated: ${new Date().toISOString()}`,
    `${zipSha}  isymcp-chatgpt-plugin.zip`,
    ...fileSummaries.map((f) => `${f.sha256}  plugin/${f.name}`),
  ];

  writeFileSync(shaSumsPath, shaSumsLines.join("\n") + "\n", "utf8");

  return {
    ok: true,
    zipPath,
    sha256: zipSha,
    files: [
      { name: "isymcp-chatgpt-plugin.zip", sha256: zipSha, size: readFileSync(zipPath).byteLength },
      ...fileSummaries,
    ],
  };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  console.log(`📦 Empaquetando ISyMCP ChatGPT Private Plugin desde ${root}...`);
  const result = packagePlugin(root);
  if (!result.ok) {
    console.error(`❌ Fallo al empaquetar: ${result.error}`);
    process.exit(1);
  }
  console.log(`✅ Paquete generado exitosamente:`);
  console.log(`   Ruta:   ${result.zipPath}`);
  console.log(`   SHA256: ${result.sha256}`);
  console.log(`   Archivos incluidos:`);
  for (const f of result.files) {
    console.log(`     - ${f.name.padEnd(30)} ${f.size.toString().padStart(8)} bytes  (${f.sha256.slice(0, 16)}...)`);
  }
}
