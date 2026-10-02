#!/usr/bin/env bun
// import-cookies.ts — construye un storageState de Playwright desde el header
// Cookie copiado a mano. Evita el problema de desencriptado del keyring de
// Chrome (Playwright exportaba 0 cookies de un perfil con 72).
//
// El archivo de entrada contiene SECRETOS; este script no imprime valores,
// solo nombres y conteos. Salida: ~/.codex-web-http/storage-state.json (0600).
//
//   bun run scripts/import-cookies.ts                     # ~/Development/cookie.txt
//   bun run scripts/import-cookies.ts --file /ruta/x.txt --out /ruta/state.json
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const file = argValue("--file") ?? join(homedir(), "Development", "cookie.txt");
const out = argValue("--out") ?? join(homedir(), ".codex-web-http", "storage-state.json");
const domain = argValue("--domain") ?? ".chatgpt.com";

if (!existsSync(file)) {
  console.error(`No existe ${file}`);
  process.exit(2);
}
const raw = await Bun.file(file).text();
const match = /^\s*cookie\s*[:=]\s*(.+)$/im.exec(raw);
if (!match) {
  console.error("No encontre una linea 'Cookie: ...' en el archivo.");
  process.exit(2);
}
let header = match[1].trim();
if (header.startsWith("(") && header.endsWith(")")) header = header.slice(1, -1).trim();

const cookies: Array<Record<string, unknown>> = [];
for (const part of header.split(";")) {
  const piece = part.trim();
  if (!piece) continue;
  const eq = piece.indexOf("=");
  if (eq <= 0) continue;
  const name = piece.slice(0, eq).trim();
  const value = piece.slice(eq + 1).trim();
  // Las cookies __Host- son host-only: domain sin punto y path "/".
  const cookieDomain = name.startsWith("__Host-") ? domain.replace(/^\./, "") : domain;
  cookies.push({
    name,
    value,
    domain: cookieDomain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
}

if (cookies.length === 0) {
  console.error("No se pudo parsear ninguna cookie.");
  process.exit(2);
}

mkdirSync(join(out, ".."), { recursive: true, mode: 0o700 });
await Bun.write(out, JSON.stringify({ cookies, origins: [] }, null, 2));
chmodSync(out, 0o600);

const names = cookies.map((cookie) => cookie.name as string);
const session = names.filter((name) => /session|clearance|secure|csrf/i.test(name));
console.log(`cookies importadas: ${cookies.length} -> ${out} (0600)`);
console.log(`clave: ${session.join(", ")}`);
