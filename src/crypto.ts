// src/crypto.ts — Utilidades criptográficas unificadas para ISyMCP.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Calcula el digest SHA-256 en formato hexadecimal.
 */
export function sha256Hex(input: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Calcula el digest SHA-256 con prefijo "sha256:".
 */
export function sha256Prefixed(input: string | Buffer | Uint8Array): string {
  return `sha256:${sha256Hex(input)}`;
}

/**
 * Calcula un HMAC hexadecimal con la clave y algoritmo indicados (por defecto sha256).
 */
export function hmacHex(secret: string, payload: string | Buffer | Uint8Array, algorithm = "sha256"): string {
  return createHmac(algorithm, secret).update(payload).digest("hex");
}

/**
 * Comparación segura contra ataques de temporización (timing attack safe) para cadenas hex/utf8.
 */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Comparación segura contra ataques de temporización para Buffers o Uint8Arrays.
 */
export function safeEqualBuffer(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  return timingSafeEqual(bufA, bufB);
}

/**
 * Genera una cadena aleatoria en formato hexadecimal de la longitud de bytes indicada.
 */
export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}
