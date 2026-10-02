#!/usr/bin/env bun
// e2e-native.ts — prueba viva del passthrough nativo contra el upstream real.
//
// No lee ~/.codex/auth.json: el token se pasa por entorno para que la
// verificacion sea explicita y revocable.
//
//   CODEX_ACCESS_TOKEN=... CODEX_ACCOUNT_ID=... bun run scripts/e2e-native.ts
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";

const config = loadConfig();
const server = startServer(config);
const token = process.env.CODEX_ACCESS_TOKEN?.trim();
const account = process.env.CODEX_ACCOUNT_ID?.trim();

if (!token) {
  console.log(
    "[e2e-native] SKIPPED: falta CODEX_ACCESS_TOKEN (y opcional CODEX_ACCOUNT_ID). " +
      "Este script no lee ~/.codex/auth.json a proposito.",
  );
  server.stop(true);
  process.exit(0);
}

const headers: Record<string, string> = { authorization: `Bearer ${token}` };
if (account) headers["chatgpt-account-id"] = account;

const res = await fetch(`http://${config.hostname}:${server.port}/v1/models`, { headers });
console.log(`[e2e-native] GET /v1/models -> ${res.status}`);
const text = await res.text();
console.log(text.slice(0, 600));

server.stop(true);
process.exit(res.ok ? 0 : 1);
