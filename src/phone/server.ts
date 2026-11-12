// src/phone/server.ts — API de ISyMCP para la app del celular (solo por Tailscale, peticiones firmadas).
//
//   GET  /v1/hello                          sin firma: nombre y versión (para que la app sepa que llegó)
//   POST /v1/pair                           sin firma, con código de `isymcp phone pair` + pruebas de ambas llaves
//   GET  /v1/status                         servicios (server, túnel, monitor, canario) + permisos + taint
//   GET  /v1/gates                          permisos, taint y lo que ChatGPT pidió y se le negó (últimos 30 min)
//   POST /v1/grant          [approve]       {cap: agents|shell, uses?, minutes?}  -> isymcp allow once
//   POST /v1/allow          [approve]       {cap, on, hours?}                     -> isymcp allow on|off
//   POST /v1/taint/clear    [approve]
//   GET  /v1/audit?last=N
//   GET  /v1/tasks?limit=N  · GET /v1/consoles · GET /v1/consoles/<id>/log?tail=N
//   POST /v1/tasks/<id>/respond [approve]   {summary}
//   POST /v1/media/import                   {url}  · GET /v1/media/jobs/<job_id>
//   POST /v1/services/<up|down|monitor-restart> [approve]
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  canonicalString, isTailscaleAddress, NonceCache, SIG_WINDOW_MS, tailscaleSelfUser, tailscaleWhois, validPublicKey, verifySignature,
  type KeyKind, type PeerIdentity, type SelfUser, type WhoIs,
} from "./auth";
import { addDevice, consumePairingCode, getDevice, normalizeCode, touchDevice, type PhoneDevice } from "./devices";

type Env = Record<string, string | undefined>;

export interface PhoneApiDeps {
  env?: Env;
  whois?: WhoIs;
  selfUser?: SelfUser;
  /** Solo tests: acepta 127.0.0.1 como si fuera Tailscale (con la identidad que dé `whois`). */
  allowLoopback?: boolean;
  /** Lanza `isymcp <paso>` desacoplado, un paso tras otro (inyectable en tests). */
  runCli?: (steps: string[][]) => void;
  now?: () => number;
}

const CAP_ALIAS: Record<string, "host_shell" | "agent_spawn"> = { shell: "host_shell", host_shell: "host_shell", agents: "agent_spawn", agent_spawn: "agent_spawn" };

const SERVICE_ACTIONS: Record<string, string[][]> = {
  up: [["up"]],
  down: [["down"]],
  "monitor-restart": [["monitor", "stop"], ["monitor", "start"]],
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function fail(status: number, error: string, detail?: string): Response {
  return json({ ok: false, error, ...(detail ? { detail } : {}) }, status);
}

function defaultRunCli(steps: string[][]): void {
  const root = join(import.meta.dir, "..", "..");
  const [first, ...rest] = steps;
  if (!first) return;
  const child = spawn("bun", ["run", join(root, "src", "isymcp.ts"), ...first], { cwd: root, detached: true, stdio: "ignore" });
  child.on("exit", () => defaultRunCli(rest));
  child.on("error", () => { /* sin aviso: queda en la bitácora que se pidió */ });
  child.unref();
}

export const PAIR_PROOF_PREFIX = "ISY1-PAIR";

/** Lo que cada llave firma al emparejar: prueba que el celular tiene ambas privadas. */
export function pairProofMessage(code: string, readKey: string, approveKey: string): string {
  return `${PAIR_PROOF_PREFIX}\n${normalizeCode(code)}\n${readKey}\n${approveKey}`;
}

export function createPhoneApi(deps: PhoneApiDeps = {}) {
  const env = deps.env ?? process.env;
  const whois = deps.whois ?? tailscaleWhois;
  const selfUser = deps.selfUser ?? tailscaleSelfUser;
  const runCli = deps.runCli ?? defaultRunCli;
  const now = deps.now ?? Date.now;
  const nonces = new NonceCache();
  let media: import("../media/service").MediaService | null = null;
  const mediaService = async () => {
    if (!media) {
      const { MediaService } = await import("../media/service");
      media = new MediaService();
    }
    return media;
  };

  /** Capas 1 y 2: red de Tailscale y mismo dueño. */
  async function peer(ip: string): Promise<PeerIdentity | Response> {
    const loop = deps.allowLoopback === true && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip);
    if (!loop && !isTailscaleAddress(ip)) return fail(403, "not_tailscale");
    const [id, self] = await Promise.all([whois(ip), selfUser()]);
    if (!id || !self) return fail(403, "unknown_peer", "tailscale whois no reconoce la IP de origen");
    if (id.user_id !== self) return fail(403, "foreign_user", "el equipo es de otro usuario de Tailscale");
    return id;
  }

  /** Capa 3: firma del dispositivo emparejado. */
  async function authenticate(req: Request, url: URL, body: Uint8Array, id: PeerIdentity, need: KeyKind): Promise<PhoneDevice | Response> {
    const deviceId = req.headers.get("x-isy-device") ?? "";
    const ts = req.headers.get("x-isy-ts") ?? "";
    const nonce = req.headers.get("x-isy-nonce") ?? "";
    const kind = (req.headers.get("x-isy-key") ?? "read") as KeyKind;
    const sig = req.headers.get("x-isy-sig") ?? "";
    if (kind !== "read" && kind !== "approve") return fail(401, "bad_key_kind");
    if (need === "approve" && kind !== "approve") return fail(401, "approve_required", "esta acción pide la llave con Face ID");
    const device = getDevice(deviceId, env);
    if (!device) return fail(401, "unknown_device", "empareja otra vez con isymcp phone pair");
    if (device.tailscale_node && device.tailscale_node !== id.node) return fail(403, "wrong_node", "esta llave se emparejó desde otro equipo de Tailscale");
    const t = Number(ts);
    if (!Number.isFinite(t) || Math.abs(now() - t) > SIG_WINDOW_MS) return fail(401, "stale_request", "revisa la hora del celular");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return fail(401, "bad_nonce");
    const msg = canonicalString(req.method, url.pathname + url.search, ts, nonce, body, kind);
    const key = kind === "approve" ? device.approve_key : device.read_key;
    if (!(await verifySignature(key, msg, sig))) return fail(401, "bad_signature");
    if (!nonces.claim(`${device.id}:${nonce}`, now())) return fail(401, "replay");
    touchDevice(device.id, env);
    return device;
  }

  async function audit(device: PhoneDevice, action: string, extra: Record<string, unknown> = {}): Promise<void> {
    const P = await import("../permissions");
    P.appendAudit({ action: `phone ${action}`, decision: "operator", source: "phone", device: device.id, device_name: device.name, ...extra }, env);
  }

  async function gates() {
    const P = await import("../permissions");
    const T = await import("../taint");
    const caps = P.CAPABILITIES.map((cap) => {
      const fg = P.fileGrant(cap, env);
      return {
        cap,
        source: P.permissionSource(cap, env),
        file_until: fg.until,
        expired: fg.expired,
        once_pending: P.pendingOnceGrants(cap, env).reduce((n, g) => n + g.uses, 0),
      };
    });
    const taint = T.activeTaint(env);
    const since = now() - 30 * 60_000;
    const pending = P.readAudit(300, env)
      .filter((r) => r.decision === "deny" && Date.parse(String(r.ts)) >= since)
      .reverse()
      .slice(0, 20)
      .map((r) => ({ ts: r.ts, cap: r.cap, action: r.action, reason: r.reason ?? null, taint: r.taint ?? null, agent: r.agent, console_id: r.console_id, command: r.command }));
    return {
      caps,
      taint: taint ? { ...taint, summary: T.describeTaint(taint, now()), gate_enabled: T.taintGateEnabled(env) } : null,
      pending,
    };
  }

  async function route(req: Request, url: URL, body: Uint8Array, id: PeerIdentity): Promise<Response> {
    const p = url.pathname;
    const m = req.method;
    const parse = (): Record<string, any> => {
      try {
        const v = JSON.parse(Buffer.from(body).toString("utf8") || "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
      } catch {
        return {};
      }
    };

    if (m === "GET" && p === "/v1/hello") return json({ ok: true, name: "ISyMCP", api: 1, peer: id.node_name });

    if (m === "POST" && p === "/v1/pair") {
      const b = parse();
      if (!(await validPublicKey(b.read_key)) || !(await validPublicKey(b.approve_key)) || b.read_key === b.approve_key) return fail(400, "bad_keys");
      const msg = pairProofMessage(String(b.code ?? ""), b.read_key, b.approve_key);
      if (!(await verifySignature(b.read_key, msg, String(b.read_proof ?? ""))) || !(await verifySignature(b.approve_key, msg, String(b.approve_proof ?? "")))) {
        return fail(400, "bad_proof");
      }
      const check = consumePairingCode(String(b.code ?? ""), env, now());
      if (check.ok === false) return fail(403, check.reason);
      const device = addDevice({ name: String(b.name ?? id.node_name ?? "iPhone"), read_key: b.read_key, approve_key: b.approve_key, tailscale_node: id.node }, env);
      await audit(device, "pair", { node: id.node_name });
      const { notifyOperator } = await import("../permissions");
      notifyOperator("ISyMCP: celular emparejado", `${device.name} (${id.node_name}). Revocar: isymcp phone revoke ${device.id}`, env);
      return json({ ok: true, device_id: device.id, name: device.name });
    }

    // Todo lo demás va firmado; lo que da permisos o toca servicios, con la llave approve.
    const needsApprove = m === "POST" && (p === "/v1/grant" || p === "/v1/allow" || p === "/v1/taint/clear" || p.startsWith("/v1/services/") || /^\/v1\/tasks\/[^/]+\/respond$/.test(p));
    const auth = await authenticate(req, url, body, id, needsApprove ? "approve" : "read");
    if (auth instanceof Response) return auth;
    const device = auth;

    if (m === "GET" && p === "/v1/status") {
      const { getControlCenterOverview } = await import("../control-center/service");
      const overview = await getControlCenterOverview(env.CODEX_WEB_HTTP_PORT?.trim() || "8791");
      return json({ ok: true, device: { id: device.id, name: device.name }, overview, gates: await gates() });
    }
    if (m === "GET" && p === "/v1/gates") return json({ ok: true, ...(await gates()) });

    if (m === "POST" && p === "/v1/grant") {
      const b = parse();
      const cap = CAP_ALIAS[String(b.cap ?? "")];
      if (!cap) return fail(400, "bad_cap", "cap: agents | shell");
      const P = await import("../permissions");
      const uses = Math.min(Math.max(Math.trunc(Number(b.uses ?? 1)) || 1, 1), P.ONCE_MAX_USES);
      const minutes = Math.min(Math.max(Number(b.minutes ?? 10) || 10, 1), 60);
      const g = P.grantOnce(cap, env, { uses, ttlMs: minutes * 60_000 });
      await audit(device, "allow once", { cap, uses, ttl: `${minutes}m` });
      return json({ ok: true, grant: g });
    }
    if (m === "POST" && p === "/v1/allow") {
      const b = parse();
      const cap = CAP_ALIAS[String(b.cap ?? "")];
      if (!cap || typeof b.on !== "boolean") return fail(400, "bad_request", "{cap: agents|shell, on: boolean, hours?}");
      const P = await import("../permissions");
      const hours = Math.min(Math.max(Number(b.hours ?? 12) || 12, 0.25), P.MAX_TTL_MS / 3600_000);
      P.setPermission(cap, b.on, env, b.on ? hours * 3600_000 : undefined);
      await audit(device, `allow ${b.on ? "on" : "off"}`, { cap, ...(b.on ? { ttl: `${Math.round(hours * 60)}m` } : {}) });
      return json({ ok: true, ...(await gates()) });
    }
    if (m === "POST" && p === "/v1/taint/clear") {
      const { clearTaint } = await import("../taint");
      const had = clearTaint(env);
      await audit(device, "taint clear");
      return json({ ok: true, cleared: had });
    }
    if (m === "GET" && p === "/v1/audit") {
      const { readAudit } = await import("../permissions");
      return json({ ok: true, rows: readAudit(Number(url.searchParams.get("last") ?? "50"), env).reverse() });
    }

    if (m === "GET" && p === "/v1/tasks") {
      const { getControlCenterTasks } = await import("../control-center/service");
      return json({ ok: true, tasks: getControlCenterTasks(Math.min(Number(url.searchParams.get("limit") ?? "30") || 30, 200), env) });
    }
    if (m === "GET" && p === "/v1/consoles") {
      const { listConsoles } = await import("../console-registry");
      const { openBridgeMonitorStack } = await import("../remote-monitor");
      const { db } = openBridgeMonitorStack(env);
      try {
        return json({ ok: true, consoles: listConsoles(db, 30, env) });
      } finally {
        db.close();
      }
    }
    const logMatch = p.match(/^\/v1\/consoles\/([A-Za-z0-9_-]{1,80})\/log$/);
    if (m === "GET" && logMatch) {
      const { readConsoleLog } = await import("../console-registry");
      const { openBridgeMonitorStack } = await import("../remote-monitor");
      const { db } = openBridgeMonitorStack(env);
      try {
        return json({ ok: true, ...readConsoleLog(db, logMatch[1]!, Math.min(Number(url.searchParams.get("tail") ?? "50") || 50, 500)) });
      } catch (e) {
        return fail(404, "console_not_found", (e as Error).message);
      } finally {
        db.close();
      }
    }
    const respondMatch = p.match(/^\/v1\/tasks\/([A-Za-z0-9_.:-]{1,120})\/respond$/);
    if (m === "POST" && respondMatch) {
      const summary = String(parse().summary ?? "").trim();
      if (!summary) return fail(400, "summary_required");
      const { respondTask } = await import("../monitor/tasks");
      const { openBridgeMonitorStack } = await import("../remote-monitor");
      const { db } = openBridgeMonitorStack(env);
      try {
        const r = respondTask(db, respondMatch[1]!, summary.slice(0, 4000), now());
        await audit(device, "task respond", { task_id: respondMatch[1] });
        return json(r, (r as { ok?: boolean }).ok === false ? 400 : 200);
      } finally {
        db.close();
      }
    }

    if (m === "POST" && p === "/v1/media/import") {
      const url2 = String(parse().url ?? "");
      if (!/^https?:\/\/\S{3,2040}$/.test(url2)) return fail(400, "bad_url");
      const svc = await mediaService();
      const r = await svc.call("media_import", { url: url2 }, { taint: false });
      await audit(device, "media import", { url: url2 });
      return mediaJson(r);
    }
    const jobMatch = p.match(/^\/v1\/media\/jobs\/(import_[a-f0-9-]{36})$/);
    if (m === "GET" && jobMatch) {
      const svc = await mediaService();
      // El operador no se contamina: esto no se le entrega al modelo.
      return mediaJson(await svc.call("media_import_status", { job_id: jobMatch[1], wait_seconds: 0 }, { taint: false }));
    }

    const svcMatch = p.match(/^\/v1\/services\/([a-z-]+)$/);
    if (m === "POST" && svcMatch) {
      const steps = SERVICE_ACTIONS[svcMatch[1]!];
      if (!steps) return fail(400, "bad_service_action", Object.keys(SERVICE_ACTIONS).join(" | "));
      // Procesos desacoplados: `isymcp down` no tumba esta API (corre aparte).
      runCli(steps);
      await audit(device, `service ${svcMatch[1]}`);
      return json({ ok: true, started: svcMatch[1] });
    }

    return fail(404, "not_found");
  }

  return {
    async fetch(req: Request, ip: string): Promise<Response> {
      try {
        const url = new URL(req.url);
        const id = await peer(ip);
        if (id instanceof Response) return id;
        const body = new Uint8Array(await req.arrayBuffer());
        if (body.length > 64 * 1024) return fail(413, "body_too_large");
        return await route(req, url, body, id);
      } catch (e) {
        return fail(500, "internal", (e as Error).message);
      }
    },
  };
}

function mediaJson(r: { isError?: boolean; content: Array<{ type: string; text?: string }> }): Response {
  const text = r.content.find((c) => c.type === "text")?.text ?? "{}";
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { text }; }
  return json({ ok: r.isError !== true, result: data }, r.isError === true ? 400 : 200);
}

export const PHONE_PORT = 8797;

/** Levanta la API SOLO en la IP de Tailscale (nunca 0.0.0.0). */
export async function startPhoneServer(opts: { port?: number; hostname?: string } = {}): Promise<{ url: string; stop: () => void }> {
  const { tailscaleIPv4 } = await import("./auth");
  const hostname = opts.hostname ?? (await tailscaleIPv4());
  if (!hostname) throw new Error("Tailscale no tiene IPv4 en esta computadora: ¿está conectado? (tailscale status)");
  if (!isTailscaleAddress(hostname)) throw new Error(`la API del celular solo escucha en Tailscale; ${hostname} no lo es`);
  const api = createPhoneApi();
  const server = Bun.serve({
    hostname,
    port: opts.port ?? PHONE_PORT,
    fetch: (req, srv) => api.fetch(req, srv.requestIP(req)?.address ?? ""),
  });
  return { url: `http://${hostname}:${server.port}`, stop: () => server.stop(true) };
}
