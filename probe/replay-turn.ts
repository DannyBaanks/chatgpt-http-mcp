#!/usr/bin/env bun
// replay-turn.ts — gate H1: replay del turno capturado con Bun.fetch puro,
// fuera del navegador. Escribe evidencia cruda (sin cookies) y decide.
//
//   bun run probe/replay-turn.ts [--evidence]
// exit 0 = PASS (respuesta SSE completa); exit 1 = FAIL (con evidencia).
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const capturePath = argValue("--capture") ?? join(homedir(), ".codex-web-http", "capture", "turn.json");
if (!existsSync(capturePath)) {
  console.error(`No existe la captura ${capturePath}. Corre primero probe/curl-capture.ts.`);
  process.exit(2);
}

const capture = JSON.parse(await Bun.file(capturePath).text()) as {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

// Headers que fetch maneja solo; el resto se reenvia tal cual (incluye cookies).
const skip = new Set(["content-length", "accept-encoding", "host", "connection"]);
const headers = new Headers();
for (const [name, value] of Object.entries(capture.headers)) {
  if (!skip.has(name.toLowerCase())) headers.set(name, value);
}

const evidenceDir = join(import.meta.dir, "evidence");
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidencePath = join(evidenceDir, `replay-${stamp}.txt`);

const lines: string[] = [];
lines.push(`replay @ ${new Date().toISOString()}`);
lines.push(`url: ${capture.url}`);
lines.push(`method: ${capture.method}`);
lines.push(`headers reenviados: ${[...headers.keys()].sort().join(", ")}`);
lines.push(`body bytes: ${capture.body ? capture.body.length : 0}`);
lines.push("");

let status = 0;
let contentType = "";
let sample = "";
let verdict = "FAIL";
let errorMessage = "";

try {
  const started = performance.now();
  const res = await fetch(capture.url, {
    method: capture.method,
    headers,
    body: capture.body ?? undefined,
    signal: AbortSignal.timeout(60_000),
  });
  status = res.status;
  contentType = res.headers.get("content-type") ?? "";
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 15_000;
  while (reader && sample.length < 16_384 && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    sample += decoder.decode(value, { stream: true });
    if (sample.includes("data: [DONE]")) break;
  }
  try {
    await reader?.cancel();
  } catch {
    /* stream ya cerrado */
  }
  const elapsed = Math.round(performance.now() - started);
  lines.push(`status: ${status}`);
  lines.push(`content-type: ${contentType || "(vacio)"}`);
  lines.push(`elapsed_ms: ${elapsed}`);
  lines.push("");
  lines.push("sample (primeros 4000 chars, sin cookies):");
  lines.push(sample.slice(0, 4_000));
  lines.push("");
  const isSse = /text\/event-stream/i.test(contentType) || sample.startsWith("data:");
  const isJsonOk = /application\/json/i.test(contentType) && status >= 200 && status < 300;
  if (status >= 200 && status < 300 && (isSse || isJsonOk) && (sample.length > 0 || isJsonOk)) {
    verdict = "PASS";
  }
} catch (error) {
  errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  lines.push(`error: ${errorMessage}`);
}

lines.push(`VERDICT: ${verdict}`);
await Bun.write(evidencePath, lines.join("\n") + "\n");
chmodSync(evidencePath, 0o644);

console.log(`status=${status} content-type=${contentType || "(vacio)"} verdict=${verdict}`);
if (errorMessage) console.log(`error=${errorMessage}`);
console.log(`evidencia=${evidencePath}`);
process.exit(verdict === "PASS" ? 0 : 1);
