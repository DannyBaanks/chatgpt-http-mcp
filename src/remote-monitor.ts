// src/remote-monitor.ts — GOAL-002: ISyMCP Remote Task Monitor
//
// Implementa el monitor residente con buzón persistente (SQLite), separación
// estricta de 4 clases de autoridad (turn_token, queue_lease, worker_lease, owner_grant),
// TTL renovable acotado por absolute_deadline, revocación transaccional inmediata,
// confinamiento realpath de workspaces y reconciliación segura (estado UNKNOWN
// sin reintento ciego para operaciones no idempotentes).
//
// Este archivo ahora solo reexporta: el monitor vive en src/monitor/ (types, db, authority, queue,
// worker, coordinator, transport, stack). Los imports existentes de "./remote-monitor" siguen igual.
export * from "./monitor/types";
export * from "./monitor/db";
export * from "./monitor/authority";
export * from "./monitor/queue";
export * from "./monitor/worker";
export * from "./monitor/coordinator";
export * from "./monitor/transport";
export * from "./monitor/stack";
export { hmacHex, safeEqualHex, sha256Hex, sha256Prefixed } from "./crypto";
