#!/usr/bin/env bun
// login.ts — login humano unico para el transporte Web (M1/M4).
//
// Abre Chrome (con display) sobre un perfil DEDICADO, espera a que la persona
// inicie sesion en ChatGPT (passkey incluida) y guarda el storageState
// (cookies de sesion) con permisos 0600. No imprime valores de cookies, no
// toca ~/.codex ni el perfil personal de Chrome, y no transmite nada.
//
//   bun run login                 # abre la ventana y espera Enter
//   bun run login -- --check      # solo resuelve rutas, no abre nada
//   bun run login -- --chrome /ruta/a/chrome --out /ruta/state.json
import { chromium, type BrowserContext } from "playwright-core";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const check = process.argv.includes("--check");
const chrome = argValue("--chrome") ?? process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const home = join(homedir(), ".codex-web-http");
const profileDir = argValue("--profile") ?? join(home, "chrome-profile");
const out = argValue("--out") ?? join(home, "storage-state.json");
const url = argValue("--url") ?? "https://chatgpt.com/";

if (!existsSync(chrome)) {
  console.error(`Chrome no encontrado en ${chrome}. Usa --chrome <ruta>.`);
  process.exit(2);
}

if (check) {
  console.log("login --check (no abre nada):");
  console.log(`  chrome:  ${chrome}`);
  console.log(`  profile: ${profileDir}`);
  console.log(`  salida:  ${out}${existsSync(out) ? " (ya existe)" : " (se creara)"}`);
  console.log(`  url:     ${url}`);
  process.exit(0);
}

mkdirSync(profileDir, { recursive: true, mode: 0o700 });
console.log(`abriendo Chrome con perfil dedicado: ${profileDir}`);

let context: BrowserContext | undefined;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chrome,
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {
    console.log("(la navegacion inicial no completo; la ventana queda abierta igual)");
  });

  console.log("");
  console.log("Inicia sesion en la ventana de Chrome (incluye passkey/2FA).");
  console.log("Cuando veas el composer de ChatGPT listo, volve aca y presiona Enter.");
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Enter cuando la sesion este lista... ");
  rl.close();

  await context.storageState({ path: out });
  chmodSync(out, 0o600);
  const state = JSON.parse(await Bun.file(out).text()) as {
    cookies: Array<{ name: string; domain: string }>;
  };
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
    console.error("No se detectaron cookies de sesion; repeti el login antes de continuar.");
    await context.close();
    process.exit(1);
  }
} catch (error) {
  console.error(`login fallo: ${error instanceof Error ? error.message : String(error)}`);
  if (context) await context.close();
  process.exit(1);
}
await context.close();
console.log("listo. Avisa al agente para continuar con el gate M1.");
