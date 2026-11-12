// src/phone/devices.ts — Celulares emparejados con ISyMCP y el código de emparejamiento de un solo uso.
//
// Cada celular tiene DOS llaves P-256 creadas en su Secure Enclave (nunca salen del equipo):
//   read     firma lo que solo mira (estado, tareas, bitácora) y lo de bajo riesgo (importar un medio).
//   approve  pide Face ID en el celular; firma lo que da permisos o toca servicios.
// El servidor guarda solo las públicas (x963, 65 bytes) y el nodo de Tailscale que emparejó.
//
// Estado en ~/.codex-web-http/phone/ (0700): devices.json y pairing.json (0600).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "../codex-sessions";

type Env = Record<string, string | undefined>;

export interface PhoneDevice {
  id: string;
  name: string;
  /** Llaves públicas P-256 en base64 (x963 sin comprimir, 65 bytes). */
  read_key: string;
  approve_key: string;
  /** StableID del nodo de Tailscale que emparejó; las peticiones deben venir de ese nodo. */
  tailscale_node: string | null;
  paired_at: string;
  last_seen?: string;
}

export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;
/** Crockford base32 sin I, L, O, U: se dicta y se teclea sin confundir. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function phoneDir(env: Env = process.env): string {
  return join(bridgeHome(env), "phone");
}

function ensureDir(env: Env): string {
  const dir = phoneDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  return dir;
}

function writeJson(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function listDevices(env: Env = process.env): PhoneDevice[] {
  const data = readJson<{ devices?: PhoneDevice[] }>(join(phoneDir(env), "devices.json"), {});
  return Array.isArray(data.devices) ? data.devices.filter((d) => d && typeof d.id === "string") : [];
}

function saveDevices(devices: PhoneDevice[], env: Env): void {
  writeJson(join(ensureDir(env), "devices.json"), { devices });
}

export function getDevice(id: string, env: Env = process.env): PhoneDevice | undefined {
  return listDevices(env).find((d) => d.id === id);
}

export function touchDevice(id: string, env: Env = process.env): void {
  const devices = listDevices(env);
  const d = devices.find((x) => x.id === id);
  if (!d) return;
  // Una escritura por minuto basta para "visto por última vez".
  if (d.last_seen && Date.now() - Date.parse(d.last_seen) < 60_000) return;
  d.last_seen = new Date().toISOString();
  saveDevices(devices, env);
}

export function revokeDevice(id: string, env: Env = process.env): boolean {
  const devices = listDevices(env);
  const next = devices.filter((d) => d.id !== id);
  if (next.length === devices.length) return false;
  saveDevices(next, env);
  return true;
}

// ─── Código de emparejamiento ────────────────────────────────────────────────

interface PairingState {
  code_hash: string;
  expires_at: string;
  attempts: number;
}

function hashCode(code: string): string {
  return createHash("sha256").update(normalizeCode(code)).digest("hex");
}

/** "k7qm 2xrp" / "K7QM-2XRP" -> "K7QM2XRP". */
export function normalizeCode(code: string): string {
  return String(code ?? "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Crea un código nuevo (invalida el anterior). Lo llama solo `isymcp phone pair`, del operador. */
export function createPairingCode(env: Env = process.env, now = Date.now()): { code: string; expires_at: string } {
  const bytes = randomBytes(8);
  let raw = "";
  for (const b of bytes) raw += CODE_ALPHABET[b % 32];
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const expires_at = new Date(now + PAIRING_TTL_MS).toISOString();
  writeJson(join(ensureDir(env), "pairing.json"), { code_hash: hashCode(code), expires_at, attempts: 0 } satisfies PairingState);
  return { code, expires_at };
}

export type PairingCheck = { ok: true } | { ok: false; reason: "no_pairing" | "expired" | "too_many_attempts" | "bad_code" };

/**
 * Comprueba y CONSUME el código: si es correcto se borra (un solo uso); si no, cuenta el intento
 * y al quinto lo anula.
 */
export function consumePairingCode(code: string, env: Env = process.env, now = Date.now()): PairingCheck {
  const path = join(phoneDir(env), "pairing.json");
  const st = readJson<PairingState | null>(path, null);
  if (!st || typeof st.code_hash !== "string") return { ok: false, reason: "no_pairing" };
  if (!(Date.parse(st.expires_at) > now)) {
    rmSync(path, { force: true });
    return { ok: false, reason: "expired" };
  }
  if (st.attempts >= PAIRING_MAX_ATTEMPTS) {
    rmSync(path, { force: true });
    return { ok: false, reason: "too_many_attempts" };
  }
  const a = Buffer.from(hashCode(code), "hex");
  const b = Buffer.from(st.code_hash, "hex");
  if (a.length === b.length && timingSafeEqual(a, b)) {
    rmSync(path, { force: true });
    return { ok: true };
  }
  const attempts = st.attempts + 1;
  if (attempts >= PAIRING_MAX_ATTEMPTS) rmSync(path, { force: true });
  else writeJson(path, { ...st, attempts });
  return { ok: false, reason: attempts >= PAIRING_MAX_ATTEMPTS ? "too_many_attempts" : "bad_code" };
}

export function addDevice(
  input: { name: string; read_key: string; approve_key: string; tailscale_node: string | null },
  env: Env = process.env,
): PhoneDevice {
  const device: PhoneDevice = {
    id: `phone-${randomBytes(6).toString("hex")}`,
    name: String(input.name || "iPhone").slice(0, 60),
    read_key: input.read_key,
    approve_key: input.approve_key,
    tailscale_node: input.tailscale_node,
    paired_at: new Date().toISOString(),
  };
  saveDevices([...listDevices(env), device], env);
  return device;
}
