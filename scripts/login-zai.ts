#!/usr/bin/env bun
// scripts/login-zai.ts — Login humano en Z.ai (chat.z.ai / z.ai) y exportación segura de sesión (cookies + localStorage).
//
// FASE 1: Abre Google Chrome NORMAL (sin flags de automatización ni CDP) para que el usuario
//         inicie sesión manualmente (evitando rechazos de Cloudflare, Google OAuth o 2FA).
// FASE 2: Al cerrar la ventana, Playwright exporta storageState (cookies y localStorage)
//         a ~/.codex-web-http/storage-state-zai.json con permisos 0600.

import { chromium, type BrowserContext } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultBrowserExecutable } from "../src/platform/browser";
import { securePrivatePath } from "../src/platform/private-path";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const chrome = argValue("--chrome") ?? process.env.CHROME_PATH ?? defaultBrowserExecutable();
const home = join(homedir(), ".codex-web-http");
const profileDir = argValue("--profile") ?? join(home, "chrome-profile-zai");
const out = argValue("--out") ?? join(home, "storage-state-zai.json");
const url = argValue("--url") ?? "https://chat.z.ai/";
const exportOnly = process.argv.includes("--export");

if (!existsSync(chrome)) {
  console.error(`Chrome no encontrado en ${chrome}. Instala Google Chrome o pasa --chrome <ruta>.`);
  process.exit(2);
}

mkdirSync(profileDir, { recursive: true, mode: 0o700 });
securePrivatePath(profileDir, true);

if (!exportOnly) {
  console.log("");
  console.log("================================================================================");
  console.log(" FASE 1 — Navegador Chrome NORMAL para Z.ai (sin automatización)");
  console.log("================================================================================");
  console.log(`URL:     ${url}`);
  console.log(`Perfil:  ${profileDir}`);
  console.log(`Destino: ${out}`);
  console.log("");
  console.log("1. Inicia sesión en Z.ai en la ventana de Chrome que se abrirá en tu pantalla.");
  console.log("2. Resuelve el login (Google, email, 2FA, etc.) hasta ver el chat o tu cuenta.");
  console.log("3. Cuando termines, CIERRA LA VENTANA DE CHROME por completo para capturar la sesión.");
  console.log("================================================================================");
  console.log("");

  const proc = Bun.spawn(
    [
      chrome,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ],
    { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
  );

  const code = await proc.exited;
  if (code !== 0) {
    console.error(`Chrome salió con código ${code}.`);
    process.exit(code || 1);
  }
  console.log("\nChrome cerrado. Exportando cookies y localStorage...");
}

// FASE 2: Extraer storageState de forma segura con Playwright headless
const preferredStore = process.env.CODEX_WEB_HTTP_PASSWORD_STORE?.trim() || "gnome-libsecret";
const stores = preferredStore === "basic" ? ["basic"] : [preferredStore, "basic"];
let context: BrowserContext | undefined;
let state: { cookies: Array<{ name: string; domain: string }>; origins: Array<{ origin: string; localStorage: Array<{ name: string }> }> } = {
  cookies: [],
  origins: [],
};

const launchWithStore = async (store: string): Promise<BrowserContext> => {
  const options = {
    executablePath: chrome,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", `--password-store=${store}`],
    ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
  };
  try {
    return await chromium.launchPersistentContext(profileDir, { ...options, chromiumSandbox: true });
  } catch {
    return await chromium.launchPersistentContext(profileDir, { ...options, chromiumSandbox: false });
  }
};

try {
  for (const store of stores) {
    context = await launchWithStore(store);
    await context.storageState({ path: out });
    securePrivatePath(out, false);
    state = JSON.parse(await Bun.file(out).text());
    if (state.cookies.length > 0 || state.origins?.length > 0) break;
    await context.close();
    context = undefined;
  }

  const cookieNames = state.cookies.map((c) => `${c.domain}:${c.name}`);
  const domains = [...new Set(state.cookies.map((c) => c.domain))];
  const storageKeys = (state.origins ?? []).flatMap((o) => o.localStorage.map((item) => `${o.origin}:${item.name}`));

  console.log("");
  console.log(`✓ Sesión guardada con éxito en: ${out} (${statSync(out).size} bytes, permisos 0600)`);
  console.log(`  Cookies capturadas:      ${state.cookies.length}`);
  console.log(`  Dominios:                ${domains.join(", ") || "(ninguno)"}`);
  console.log(`  Claves en localStorage:  ${storageKeys.length}`);
  if (storageKeys.length > 0) {
    console.log(`  Orígenes con storage:    ${state.origins.map((o) => `${o.origin} (${o.localStorage.length} claves)`).join(", ")}`);
  }

  // Guardar copia en ~/.codex-web-http/sessions/zai/
  const zaiSessionDir = join(home, "sessions", "zai");
  mkdirSync(zaiSessionDir, { recursive: true });
  const zaiSessionFile = join(zaiSessionDir, "storage-state.json");
  writeFileSync(zaiSessionFile, readFileSync(out, "utf8"), { mode: 0o600 });
  securePrivatePath(zaiSessionFile, false);

  const zaiRecord = {
    name: "zai",
    statePath: zaiSessionFile,
    conversationUrl: null,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(home, "sessions", "zai.json"), JSON.stringify(zaiRecord, null, 2) + "\n", { mode: 0o600 });
  console.log(`✓ Registrado en perfil de sesión ISyMCP: ${join(home, "sessions", "zai.json")}`);
} catch (error) {
  console.error("Error durante la exportación:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
}
