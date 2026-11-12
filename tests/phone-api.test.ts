// tests/phone-api.test.ts — la API del celular: solo Tailscale, mismo dueño, peticiones firmadas, Face ID para permisos.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalString, isTailscaleAddress, type PeerIdentity } from "../src/phone/auth";
import { createPairingCode, listDevices, revokeDevice } from "../src/phone/devices";
import { createPhoneApi, pairProofMessage } from "../src/phone/server";

let home: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["CODEX_WEB_HTTP_HOME", "ISYMCP_ALLOW_HOST_SHELL", "ISYMCP_ALLOW_AGENT_SPAWN", "ISYMCP_TAINT_GATE"];
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "isymcp-phone-"));
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.CODEX_WEB_HTTP_HOME = home;
  for (const k of KEYS.slice(1)) delete process.env[k];
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

const SELF = "100000000000001";
const IPHONE: PeerIdentity = { user_id: SELF, login: "me@x", node: "nodeIPHONE", node_name: "iphone-12", os: "iOS" };
const OTHER_NODE: PeerIdentity = { ...IPHONE, node: "nodeOTHER", node_name: "laptop" };
let peer: PeerIdentity | null = IPHONE;
const ran: string[][][] = [];
const api = createPhoneApi({
  allowLoopback: true,
  whois: async () => peer,
  selfUser: async () => SELF,
  runCli: (steps) => { ran.push(steps); },
});
beforeEach(() => { peer = IPHONE; });

/** Un "celular" con dos llaves P-256 (como el Secure Enclave). */
async function makePhone() {
  const gen = () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
  const [read, approve] = await Promise.all([gen(), gen()]);
  const pub = async (k: CryptoKeyPair) => Buffer.from(await crypto.subtle.exportKey("raw", k.publicKey)).toString("base64");
  const sign = async (k: CryptoKeyPair, msg: string) =>
    Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, Buffer.from(msg))).toString("base64");
  const phone = { read, approve, read_pub: await pub(read), approve_pub: await pub(approve), sign, id: "" };
  return phone;
}
type Phone = Awaited<ReturnType<typeof makePhone>>;

const BASE = "http://100.100.10.10:8797";
const call = (req: Request, ip = "127.0.0.1") => api.fetch(req, ip);

async function pair(phone: Phone, code: string, overrides: Record<string, unknown> = {}) {
  const msg = pairProofMessage(code, phone.read_pub, phone.approve_pub);
  const body = {
    code, name: "iPhone de prueba", read_key: phone.read_pub, approve_key: phone.approve_pub,
    read_proof: await phone.sign(phone.read, msg), approve_proof: await phone.sign(phone.approve, msg), ...overrides,
  };
  return call(new Request(`${BASE}/v1/pair`, { method: "POST", body: JSON.stringify(body) }));
}

let nonceN = 0;
async function signed(phone: Phone, method: string, path: string, body?: unknown, opts: { key?: "read" | "approve"; ts?: number; nonce?: string; tamper?: string } = {}) {
  const key = opts.key ?? "read";
  const text = body === undefined ? "" : JSON.stringify(body);
  const ts = String(opts.ts ?? Date.now());
  const nonce = opts.nonce ?? `nonce-${Date.now()}-${nonceN++}-abcdef`;
  const sig = await phone.sign(key === "approve" ? phone.approve : phone.read, canonicalString(method, path, ts, nonce, text, key));
  return call(new Request(`${BASE}${path}`, {
    method,
    body: method === "GET" ? undefined : (opts.tamper ?? text),
    headers: { "x-isy-device": phone.id, "x-isy-ts": ts, "x-isy-nonce": nonce, "x-isy-key": key, "x-isy-sig": sig },
  }));
}

let phone: Phone;

describe("red y dueño", () => {
  it("PH-01: solo direcciones de Tailscale", () => {
    for (const ip of ["100.64.0.1", "100.127.255.255", "fd7a:115c:a1e0::1", "::ffff:100.100.1.1"]) expect(isTailscaleAddress(ip)).toBe(true);
    for (const ip of ["100.63.0.1", "100.128.0.1", "192.168.1.5", "10.0.0.2", "8.8.8.8", "fe80::1", "127.0.0.1"]) expect(isTailscaleAddress(ip)).toBe(false);
  });

  it("PH-02: fuera de Tailscale, IP desconocida u otro usuario: 403", async () => {
    expect((await call(new Request(`${BASE}/v1/hello`), "192.168.1.5")).status).toBe(403);
    peer = null;
    expect(await (await call(new Request(`${BASE}/v1/hello`))).json()).toMatchObject({ error: "unknown_peer" });
    peer = { ...IPHONE, user_id: "otro" };
    expect(await (await call(new Request(`${BASE}/v1/hello`))).json()).toMatchObject({ error: "foreign_user" });
    peer = IPHONE;
    expect(await (await call(new Request(`${BASE}/v1/hello`))).json()).toMatchObject({ ok: true, name: "ISyMCP", peer: "iphone-12" });
  });
});

describe("emparejar", () => {
  it("PH-03: sin código no se empareja; pruebas de llave falsas no sirven; el código es de un solo uso", async () => {
    phone = await makePhone();
    expect(await (await pair(phone, "AAAA-BBBB")).json()).toMatchObject({ error: "no_pairing" });
    const { code } = createPairingCode();
    const other = await makePhone();
    // approve_proof firmado con otra llave: no prueba posesión.
    const bad = await other.sign(other.approve, pairProofMessage(code, phone.read_pub, phone.approve_pub));
    expect(await (await pair(phone, code, { approve_proof: bad })).json()).toMatchObject({ error: "bad_proof" });
    expect(await (await pair(phone, code, { approve_key: phone.read_pub })).json()).toMatchObject({ error: "bad_keys" });
    const ok = await (await pair(phone, code.toLowerCase().replace("-", " "))).json();
    expect(ok).toMatchObject({ ok: true, name: "iPhone de prueba" });
    phone.id = ok.device_id;
    expect(listDevices()[0]).toMatchObject({ id: phone.id, tailscale_node: "nodeIPHONE" });
    expect(await (await pair(await makePhone(), code)).json()).toMatchObject({ error: "no_pairing" });
  });

  it("PH-04: 5 códigos equivocados anulan el código", async () => {
    const p = await makePhone();
    const { code } = createPairingCode();
    for (let i = 0; i < 4; i++) expect(await (await pair(p, "ZZZZ-ZZZZ")).json()).toMatchObject({ error: "bad_code" });
    expect(await (await pair(p, "ZZZZ-ZZZZ")).json()).toMatchObject({ error: "too_many_attempts" });
    expect(await (await pair(p, code)).json()).toMatchObject({ error: "no_pairing" });
  });
});

describe("peticiones firmadas", () => {
  it("PH-05: firmada pasa; sin firma, firma mala, hora vieja, nonce repetido o cuerpo cambiado no", async () => {
    expect((await signed(phone, "GET", "/v1/gates")).status).toBe(200);
    expect(await (await call(new Request(`${BASE}/v1/gates`))).json()).toMatchObject({ error: "unknown_device" });
    const other = await makePhone();
    other.id = phone.id;
    expect(await (await signed(other, "GET", "/v1/gates")).json()).toMatchObject({ error: "bad_signature" });
    expect(await (await signed(phone, "GET", "/v1/gates", undefined, { ts: Date.now() - 120_000 })).json()).toMatchObject({ error: "stale_request" });
    await signed(phone, "GET", "/v1/gates", undefined, { nonce: "repetido-1234567890" });
    expect(await (await signed(phone, "GET", "/v1/gates", undefined, { nonce: "repetido-1234567890" })).json()).toMatchObject({ error: "replay" });
    const r = await signed(phone, "POST", "/v1/grant", { cap: "agents", uses: 1 }, { key: "approve", tamper: JSON.stringify({ cap: "shell", uses: 10 }) });
    expect(await r.json()).toMatchObject({ error: "bad_signature" });
  });

  it("PH-06: la llave sirve solo desde el nodo de Tailscale que emparejó", async () => {
    peer = OTHER_NODE;
    expect(await (await signed(phone, "GET", "/v1/gates")).json()).toMatchObject({ error: "wrong_node" });
  });

  it("PH-07: dar permisos pide la llave approve (Face ID); con ella, el permiso de un solo uso abre la puerta contaminada", async () => {
    const { checkGate } = await import("../src/permissions");
    const { markTainted, clearTaint } = await import("../src/taint");
    markTainted("github.issues", "evil/repo");
    const g0 = await (await signed(phone, "GET", "/v1/gates")).json();
    expect(g0.taint.summary).toContain("github.issues");
    expect(checkGate("agent_spawn", "tui.spawn", { agent: "claude" }).ok).toBe(false);
    const pend = await (await signed(phone, "GET", "/v1/gates")).json();
    expect(pend.pending[0]).toMatchObject({ cap: "agent_spawn", action: "tui.spawn", agent: "claude" });
    expect(await (await signed(phone, "POST", "/v1/grant", { cap: "agents" })).json()).toMatchObject({ error: "approve_required" });
    const ok = await (await signed(phone, "POST", "/v1/grant", { cap: "agents", uses: 1 }, { key: "approve" })).json();
    expect(ok.grant).toMatchObject({ cap: "agent_spawn", uses: 1 });
    expect(checkGate("agent_spawn", "tui.spawn", { agent: "claude" })).toEqual({ ok: true, source: "once" });
    expect(checkGate("agent_spawn", "tui.spawn", { agent: "claude" }).ok).toBe(false);
    expect(await (await signed(phone, "POST", "/v1/taint/clear", {}, { key: "approve" })).json()).toMatchObject({ ok: true, cleared: true });
    clearTaint();
    const { readAudit } = await import("../src/permissions");
    const rows = readAudit(50).filter((r) => r.source === "phone");
    expect(rows.map((r) => r.action)).toEqual(["phone pair", "phone allow once", "phone taint clear"]);
    expect(rows.every((r) => r.device === phone.id)).toBe(true);
  });

  it("PH-08: allow on/off desde el celular, acotado a 24 h", async () => {
    const { fileGrant, MAX_TTL_MS } = await import("../src/permissions");
    await signed(phone, "POST", "/v1/allow", { cap: "shell", on: true, hours: 999 }, { key: "approve" });
    const fg = fileGrant("host_shell");
    expect(fg.on).toBe(true);
    expect(Date.parse(fg.until!) - Date.now()).toBeLessThanOrEqual(MAX_TTL_MS);
    await signed(phone, "POST", "/v1/allow", { cap: "shell", on: false }, { key: "approve" });
    expect(fileGrant("host_shell").on).toBe(false);
  });

  it("PH-09: servicios: pasos fijos y nada más", async () => {
    expect(await (await signed(phone, "POST", "/v1/services/monitor-restart", {}, { key: "approve" })).json()).toMatchObject({ ok: true });
    expect(ran.at(-1)).toEqual([["monitor", "stop"], ["monitor", "start"]]);
    expect((await signed(phone, "POST", "/v1/services/rm-rf", {}, { key: "approve" })).status).toBe(400);
    expect(await (await signed(phone, "POST", "/v1/services/up", {})).json()).toMatchObject({ error: "approve_required" });
  });

  it("PH-10: lo que ve el operador por el celular no contamina", async () => {
    const { MediaService } = await import("../src/media/service");
    const { MediaCatalog } = await import("../src/media/catalog");
    const { activeTaint } = await import("../src/taint");
    const svc = new MediaService(new MediaCatalog(join(home, "media")));
    await svc.call("media_list", {}, { taint: false });
    expect(activeTaint()).toBeNull();
    expect((await signed(phone, "POST", "/v1/media/import", { url: "file:///etc/passwd" })).status).toBe(400);
  });

  it("PH-11: revocar corta el acceso", async () => {
    expect(revokeDevice(phone.id)).toBe(true);
    expect(await (await signed(phone, "GET", "/v1/gates")).json()).toMatchObject({ error: "unknown_device" });
  });
});
