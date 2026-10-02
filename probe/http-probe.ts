#!/usr/bin/env bun
// http-probe.ts — gate M1 (sonda por etapas) con Authorization + Cookie
// copiados a mano. No imprime valores de cookies/tokens; escribe evidencia
// local en probe/evidence/.
//
//   bun run probe/http-probe.ts [--auth-file ~/Development/cookie.txt]
//
// Etapas (cada una responde una pregunta distinta):
//   1) GET /api/auth/session                 -> cookies + Cloudflare + Bun fetch
//   2) GET /backend-api/conversations?...    -> cookie + bearer autentican
//   3) POST /backend-api/f/conversation      -> exige sentinel/headers de SPA?
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const authFile = argValue("--auth-file") ?? join(homedir(), "Development", "cookie.txt");
if (!existsSync(authFile)) {
  console.error(`No existe ${authFile}`);
  process.exit(2);
}
const raw = await Bun.file(authFile).text();
const lines = raw.split(/\r?\n/);

let authorization = "";
let cookie = "";
for (const line of lines) {
  const m = /^\s*(authorization|cookie)\s*[:=]\s*(.+)$/i.exec(line);
  if (!m) continue;
  const name = m[1].toLowerCase();
  let value = m[2].trim();
  if (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1).trim();
  if (name === "authorization") authorization = value;
  if (name === "cookie") cookie = value;
}
if (!cookie) {
  console.error("No encontre header Cookie en el archivo.");
  process.exit(2);
}

// UA tipo Chrome (el cf_clearance esta atado al UA que emitio el challenge).
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const base = {
  cookie,
  "user-agent": UA,
  accept: "*/*",
  "accept-language": "es-ES,es;q=0.9",
  referer: "https://chatgpt.com/",
};
if (authorization) base["authorization"] = authorization;

const evidenceDir = join(import.meta.dir, "evidence");
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidencePath = join(evidenceDir, `http-probe-${stamp}.md`);
const out: string[] = [];
out.push(`# HTTP probe @ ${new Date().toISOString()}`);
out.push(`auth-file: ${authFile}`);
out.push(`authorization presente: ${authorization ? "si" : "no"} (largo ${authorization.length})`);
out.push("");

async function stage(label: string, url: string, init: RequestInit): Promise<{ status: number; ct: string; body: string }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const ms = Math.round(performance.now() - t0);
    out.push(`## ${label}`);
    out.push(`url: ${url}`);
    out.push(`status: ${res.status} | content-type: ${ct || "(vacio)"} | ${ms}ms | body ${body.length} bytes`);
    out.push("");
    out.push("```");
    out.push(body.slice(0, 1200));
    out.push("```");
    out.push("");
    console.log(`${label}: status=${res.status} ct=${ct || "(vacio)"} bytes=${body.length} ${ms}ms`);
    return { status: res.status, ct, body };
  } catch (error) {
    const ms = Math.round(performance.now() - t0);
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    out.push(`## ${label}`);
    out.push(`url: ${url}`);
    out.push(`ERROR tras ${ms}ms: ${message}`);
    out.push("");
    console.log(`${label}: ERROR ${message}`);
    return { status: 0, ct: "", body: "" };
  }
}

const s1 = await stage("1. session (cookies)", "https://chatgpt.com/api/auth/session", {
  method: "GET",
  headers: { cookie, "user-agent": UA, accept: "application/json" },
});

const s2 = await stage(
  "2. conversations (cookie+bearer)",
  "https://chatgpt.com/backend-api/conversations?offset=0&limit=1&order=updated",
  { method: "GET", headers: base },
);

const minimalBody = JSON.stringify({
  action: "next",
  messages: [
    {
      id: crypto.randomUUID(),
      author: { role: "user" },
      content: { content_type: "text", parts: ["ok"] },
    },
  ],
  model: "auto",
  timezone_offset_min: 0,
  suggestions: [],
  history_and_training_disabled: true,
  conversation_mode: { kind: "primary_assistant" },
  force_paragen: false,
});
const s3 = await stage("3. f/conversation (sentinel?)", "https://chatgpt.com/backend-api/f/conversation", {
  method: "POST",
  headers: { ...base, "content-type": "application/json", origin: "https://chatgpt.com" },
  body: minimalBody,
});

writeFileSync(evidencePath, out.join("\n"), { mode: 0o600 });
console.log("");
console.log(`evidencia: ${evidencePath} (0600)`);
console.log(
  `veredicto basico: ${s1.status >= 200 && s1.status < 300 && s2.status >= 200 && s2.status < 300 ? "AUTENTICADO-FUERA-DEL-BROWSER" : "BLOQUEADO"}`,
);
console.log(
  `turno completo: ${s3.status >= 200 && s3.status < 300 ? "OK" : `NO (status=${s3.status}; ver evidencia)`}`,
);
process.exit(0);
