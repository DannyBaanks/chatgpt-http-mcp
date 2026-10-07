#!/usr/bin/env bun
// login.ts — login humano unico para el transporte Web (M1/M4).
//
// POR QUE EN DOS FASES: Google rechaza el OAuth si el navegador viene con
// flags de automatizacion (Playwright agrega --no-sandbox/--enable-automation
// por default y accounts.google.com responde "browser or app may not be
// secure"). Entonces:
//   Fase 1 — se abre Chrome NORMAL con el perfil dedicado (sin CDP, sin flags
//            de automatizacion): ahi la persona inicia sesion con passkey.
//   Fase 2 — recien despues, Playwright abre ese mismo perfil en headless
//            solo para exportar el storageState (cookies) con permisos 0600.
//
//   bun run login              # fase 1 + fase 2 cuando cierres Chrome
//   bun run login -- --export  # solo fase 2 (perfil ya logueado)
//   bun run login -- --check   # rutas, no abre nada
import { chromium, type BrowserContext } from "playwright-core";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const check = process.argv.includes("--check");
const exportOnly = process.argv.includes("--export");
const chrome = argValue("--chrome") ?? process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const home = join(homedir(), ".codex-web-http");
const profileDir = argValue("--profile") ?? join(home, "chrome-profile");
const out = argValue("--out") ?? join(home, "storage-state.json");
const url = argValue("--url") ?? "https://chatgpt.com/";

if (!existsSync(chrome)) {
  console.error(`Chrome no encontrado en ${chrome}. Usa --chrome <ruta>.`);
  process.exit(2);
}

if (process.argv.includes("--status")) {
  const dbPath = join(profileDir, "Default", "Cookies");
  if (!existsSync(dbPath)) {
    console.error(`Sin base de cookies del perfil: ${dbPath}`);
    process.exit(1);
  }
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .query("select host_key as host, name from cookies order by host_key")
    .all() as Array<{ host: string; name: string }>;
  const hosts = new Map<string, string[]>();
  for (const row of rows) {
    const list = hosts.get(row.host) ?? [];
    list.push(row.name);
    hosts.set(row.host, list);
  }
  console.log(`perfil: ${profileDir}`);
  console.log(`cookies en DB: ${rows.length}`);
  for (const [host, names] of [...hosts.entries()].sort()) {
    const session = names.filter((name) => /session|__Secure|clearance|token/i.test(name));
    console.log(`  ${host}: ${names.length}${session.length ? `  sesion: ${session.join(", ")}` : ""}`);
  }
  const hasSession = rows.some((row) => /session|__Secure|clearance/i.test(row.name));
  console.log(hasSession ? "ESTADO: sesion detectada (puedes exportar)" : "ESTADO: SIN cookies de sesion (falta completar el login)");
  process.exit(hasSession ? 0 : 1);
}

if (check) {
  console.log("login --check (no abre nada):");
  console.log(`  chrome:  ${chrome}`);
  console.log(`  profile: ${profileDir}`);
  console.log(`  salida:  ${out}${existsSync(out) ? " (ya existe)" : " (se creara)"}`);
  console.log(`  url:     ${url}`);
  console.log(`  fase:    ${exportOnly ? "solo export" : "login + export"}`);
  process.exit(0);
}

mkdirSync(profileDir, { recursive: true, mode: 0o700 });

if (!exportOnly) {
  console.log("");
  console.log("FASE 1 — Chrome NORMAL (sin automatizacion, sin --no-sandbox).");
  console.log(`Perfil dedicado: ${profileDir}`);
  console.log("");
  console.log("Inicia sesion en ChatGPT (passkey/2FA). Cuando termines,");
  console.log("CIERRA LA VENTANA DE CHROME POR COMPLETO para continuar.");
  console.log("");

  const proc = Bun.spawn(
    [
      chrome,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`Chrome salio con codigo ${code}; si quedaron ventanas abiertas, ciérralas y reintenta.`);
    process.exit(1);
  }
  console.log("Chrome cerrado. Exportando cookies...");
}

// FASE 2 — solo lectura de cookies del perfil recien logueado.
// En Linux, Chrome normal cifra las cookies con el keyring (gnome-libsecret).
// Playwright lanza por defecto con --password-store=basic + --use-mock-keychain
// y no puede descifrarlas: el export saldria en 0 cookies. Se ignoran esos
// defaults, se prueba primero el keyring (override con CODEX_WEB_HTTP_PASSWORD_STORE)
// y se cae a "basic" si el perfil quedo cifrado con el fallback.
const preferredStore = process.env.CODEX_WEB_HTTP_PASSWORD_STORE?.trim() || "gnome-libsecret";
const stores = preferredStore === "basic" ? ["basic"] : [preferredStore, "basic"];
let context: BrowserContext | undefined;
let state: { cookies: Array<{ name: string }> } = { cookies: [] };

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
    // En hosts sin user namespaces el sandbox falla; el export no navega nada.
    return await chromium.launchPersistentContext(profileDir, { ...options, chromiumSandbox: false });
  }
};

try {
  for (const store of stores) {
    context = await launchWithStore(store);
    await context.storageState({ path: out });
    chmodSync(out, 0o600);
    state = JSON.parse(await Bun.file(out).text()) as { cookies: Array<{ name: string }> };
    if (state.cookies.length > 0) break;
    await context.close();
    context = undefined;
  }
  const interesting = state.cookies
    .filter((cookie) => /session|__Secure|cf_clearance/i.test(cookie.name))
    .map((cookie) => cookie.name);
  console.log("");
  console.log(`guardado: ${out} (${statSync(out).size} bytes, permisos 0600)`);
  console.log(`cookies totales: ${state.cookies.length}`);
  console.log(
    `cookies de sesion detectadas: ${interesting.length > 0 ? interesting.join(", ") : "NINGUNA (revisa el login)"}`,
  );
  if (interesting.length === 0) {
    console.error("");
    console.error("NO HAY SESION en este perfil: el login no llego a completarse.");
    console.error("Revisa con:  bun run login -- --status");
    console.error("Si dice SIN cookies: corre 'bun run login' otra vez, inicia sesion");
    console.error("en la ventana y después ciérrala por completo.");
    if (context) await context.close();
    process.exit(1);
  }
  console.log("");
  console.log("listo. Avisa al agente para continuar con el gate M1.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(message)) {
    console.error("El perfil esta en uso: cerra TODAS las ventanas de Chrome de este perfil y reintenta con --export.");
  } else {
    console.error(`export fallo: ${message}`);
  }
  if (context) await context.close();
  process.exit(1);
}
if (context) await context.close();
