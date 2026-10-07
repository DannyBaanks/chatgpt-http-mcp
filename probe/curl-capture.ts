#!/usr/bin/env bun
// curl-capture.ts — convierte un "Copy as cURL (bash)" de DevTools en una
// captura estructurada para el gate M1.
//
// El archivo de entrada contiene SECRETOS (cookies de sesion). Este script:
//   - nunca imprime valores de cookies ni tokens;
//   - escribe la captura en ~/.codex-web-http/capture/turn.json (0600);
//   - imprime solo metadata (url, cantidad de headers, nombres de cookies).
//
//   bun run probe/curl-capture.ts                       # lee ~/Development/cookie.txt
//   bun run probe/curl-capture.ts --curl /ruta/otro.txt
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const file = argValue("--curl") ?? join(homedir(), "Development", "cookie.txt");
const out = argValue("--out") ?? join(homedir(), ".codex-web-http", "capture", "turn.json");

if (!existsSync(file)) {
  console.error(`No existe ${file}. Copia la request como cURL (bash) y guárdala ahí.`);
  process.exit(2);
}
const raw = await Bun.file(file).text();

/** Extrae strings entre comillas simples manejando el escape bash '\\''. */
function extractQuoted(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "'") {
      i++;
      continue;
    }
    let j = i + 1;
    let buf = "";
    while (j < text.length) {
      if (text[j] === "'") {
        if (text[j + 1] === "\\" && text[j + 2] === "'" && text[j + 3] === "'") {
          buf += "'";
          j += 4;
          continue;
        }
        break;
      }
      if (text[j] === "\\" && j + 1 < text.length) {
        buf += text[j + 1];
        j += 2;
        continue;
      }
      buf += text[j];
      j++;
    }
    out.push(buf);
    i = j + 1;
  }
  return out;
}

const tokens = extractQuoted(raw);
if (tokens.length === 0) {
  console.error("No se encontraron strings entre comillas simples; usa 'Copy as cURL (bash)'.");
  process.exit(2);
}

let url: string | undefined;
let method = "POST";
let body: string | undefined;
const headers: Record<string, string> = {};

for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  if (token.startsWith("http://") || token.startsWith("https://")) {
    url = token;
    continue;
  }
  const lower = token.toLowerCase();
  if (lower === "get" || lower === "post" || lower === "put" || lower === "delete") {
    method = token.toUpperCase();
    continue;
  }
  // Los headers vienen como token independiente: "name: value".
  if (/^[A-Za-z0-9-]+:\s/.test(token) && !token.startsWith("{")) {
    const sep = token.indexOf(":");
    const name = token.slice(0, sep).trim();
    const value = token.slice(sep + 1).trim();
    if (lower.startsWith("cookie:") || lower.startsWith("authorization:") || name) {
      headers[name] = value;
    }
    continue;
  }
  if (token.startsWith("{")) {
    body = token;
  }
}

if (!url) {
  console.error("No se encontro la URL en el cURL.");
  process.exit(2);
}
if (!headers["cookie"] && !headers["Cookie"]) {
  console.error("El cURL no trae header cookie; copia la request real de chatgpt.com (no un fetch generico).");
  process.exit(2);
}

const cookieHeader = headers["cookie"] ?? headers["Cookie"];
const cookieNames = cookieHeader
  .split(";")
  .map((part) => part.split("=")[0]?.trim())
  .filter(Boolean)
  .filter((name) => /session|__Secure|clearance|token|oai/i.test(name));

mkdirSync(join(out, ".."), { recursive: true, mode: 0o700 });
const capture = {
  captured_at: new Date().toISOString(),
  source: file,
  url,
  method,
  headers,
  body: body ?? null,
};
await Bun.write(out, JSON.stringify(capture, null, 2));
chmodSync(out, 0o600);

console.log("captura OK (sin imprimir secretos):");
console.log(`  url:      ${url}`);
console.log(`  metodo:   ${method}`);
console.log(`  headers:  ${Object.keys(headers).length}`);
console.log(`  body:     ${body ? `${body.length} bytes` : "sin body"}`);
console.log(`  cookies:  ${cookieHeader.split(";").length} (nombres clave: ${cookieNames.join(", ") || "ninguno"})`);
console.log(`  guardado: ${out} (0600)`);
if (!url.includes("/backend-api/")) {
  console.warn("AVISO: la URL no es /backend-api/... ¿copiaste la request correcta?");
}
