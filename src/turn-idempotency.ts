// turn-idempotency.ts — M5 (P0): exactly-once por turno.
//
// Idempotency-Key: header `x-isymcp-turn-id`. Semantica:
//   - duplicado COMPLETADO  -> devuelve la MISMA respuesta, sin re-ejecutar;
//   - duplicado EN VUELO    -> espera la MISMA promesa (una sola ejecucion);
//   - sin header            -> comportamiento normal (sin cache).
// Store: ~/.codex-web-http/turns/<sha256(turnId)[:32]>.json (0600, best-effort).
// Limite v0 documentado: respuestas 5xx son ambiguas y NO se cachean (un retry
// puede re-ejecutar); 2xx/4xx son definitivas y se cachean.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "./codex-sessions";

export interface TurnRecord {
  ts: string;
  status: number;
  contentType: string;
  body: string;
}

function storeDir(): string {
  return join(bridgeHome(), "turns");
}

function recordPath(turnId: string): string {
  // Hash del id: evita path traversal y limita el nombre del archivo.
  return join(storeDir(), `${createHash("sha256").update(turnId).digest("hex").slice(0, 32)}.json`);
}

export function readTurnRecord(turnId: string): TurnRecord | null {
  try {
    return JSON.parse(readFileSync(recordPath(turnId), "utf8")) as TurnRecord;
  } catch {
    return null;
  }
}

function writeTurnRecord(turnId: string, record: TurnRecord): void {
  try {
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(recordPath(turnId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    /* cache best-effort: nunca rompe el turno */
  }
}

function toResponse(record: TurnRecord, replayed: boolean): Response {
  return new Response(record.body, {
    status: record.status,
    headers: { "content-type": record.contentType, "x-isymcp-replayed": replayed ? "1" : "0" },
  });
}

const inflight = new Map<string, Promise<TurnRecord>>();

export async function runIdempotent(
  turnId: string | null,
  run: () => Promise<Response>,
): Promise<Response> {
  if (!turnId) return run();

  const done = readTurnRecord(turnId);
  if (done) return toResponse(done, true);

  const pending = inflight.get(turnId);
  if (pending) {
    const record = await pending;
    return toResponse(record, true);
  }

  const execution = (async (): Promise<TurnRecord> => {
    const response = await run();
    const record: TurnRecord = {
      ts: new Date().toISOString(),
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: await response.text(),
    };
    if (response.status < 500) writeTurnRecord(turnId, record);
    return record;
  })();
  inflight.set(turnId, execution);
  try {
    return toResponse(await execution, false);
  } finally {
    inflight.delete(turnId);
  }
}
