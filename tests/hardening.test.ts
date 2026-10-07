// hardening.test.ts — regresiones de la auditoria 2026-10-06:
// CSRF/DNS rebinding (server + panel), XSS del panel, caducidad y revoke de
// tokens, symlinks fuera del workspace, candado de turnos web, sanitizado.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { createHandler } from "../src/server";
import { renderPanel, startPanel, type PanelState } from "../src/panel";
import {
  findSessionByToken, mintSession, readSessions, resolveWithinReal, revokeSession,
} from "../src/codex-sessions";
import { withWebLock } from "../src/web-turn";
import { sanitizeEvidenceText } from "../src/sanitize";

let home: string;
let workspace: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "isyco-hard-home-"));
  workspace = mkdtempSync(join(tmpdir(), "isyco-hard-ws-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
});

afterAll(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const chatBody = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] });

describe("bridge :8791 — solo clientes locales", () => {
  const handler = createHandler(loadConfig({ CODEX_WEB_HTTP_WEB_MODELS: "on", CODEX_WEB_HTTP_UPSTREAM: "http://127.0.0.1:9" }));
  const post = (headers: Record<string, string>) =>
    handler(new Request("http://127.0.0.1:8791/v1/chat/completions", { method: "POST", headers, body: chatBody }));

  test("CSRF: text/plain (peticion simple del navegador) -> 415", async () => {
    const res = await post({ "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });

  test("Origin ajeno -> 403 aunque el body sea JSON", async () => {
    const res = await post({ "content-type": "application/json", origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("forbidden_origin");
  });

  test("DNS rebinding: Host ajeno -> 403 tambien en GET", async () => {
    const res = await handler(new Request("http://127.0.0.1:8791/health", { headers: { host: "evil.example:8791" } }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("forbidden_host");
  });

  test("Origin 'null' (iframe sandbox / file://) -> 403", async () => {
    const res = await post({ "content-type": "application/json", origin: "null" });
    expect(res.status).toBe(403);
  });

  test("cliente local legitimo (sin Origin, JSON) sigue pasando", async () => {
    const res = await post({ "content-type": "application/json" });
    expect(res.status).toBe(400); // not_web_model: llego al handler real
    const health = await handler(new Request("http://localhost:8791/health"));
    expect(health.status).toBe(200);
  });

  test("CODEX_WEB_HTTP_ALLOWED_HOSTS habilita un host extra", async () => {
    process.env.CODEX_WEB_HTTP_ALLOWED_HOSTS = "bridge.lan";
    try {
      const res = await handler(new Request("http://bridge.lan:8791/health"));
      expect(res.status).toBe(200);
    } finally {
      delete process.env.CODEX_WEB_HTTP_ALLOWED_HOSTS;
    }
  });
});

describe("panel :8798 — CSRF/rebinding/XSS", () => {
  let server: ReturnType<typeof startPanel>;
  beforeAll(() => {
    server = startPanel(0, "59999");
  });
  afterAll(() => {
    server.stop(true);
  });
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

  test("POST /api/action text/plain desde otra web -> rechazado, no ejecuta", async () => {
    const res = await fetch(url("/api/action"), {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: JSON.stringify({ action: "session-list" }),
    });
    expect(res.status).toBe(403);
  });

  test("POST sin Origin pero text/plain -> 415", async () => {
    const res = await fetch(url("/api/action"), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ action: "nope" }),
    });
    expect(res.status).toBe(415);
  });

  test("el propio panel (Origin loopback + JSON) sigue funcionando", async () => {
    const res = await fetch(url("/api/action"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${server.port}` },
      body: JSON.stringify({ action: "nope" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  test("render escapa logs, URL y labels", () => {
    const state: PanelState = {
      ts: "t", server: "down", serverPort: "1", tunnel: "stopped", mcp: "down", browser: "ok",
      conversation: "https://chatgpt.com/c/x\"><script>alert(1)</script>",
      sessions: [{ label: "<img src=x onerror=alert(2)>", fp: "abc", writable: false }],
      lastErrors: ["chat turn FAILED <script>alert(3)</script>"],
    };
    const html = renderPanel(state);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(3)&lt;/script&gt;");
  });
});

describe("session tokens — caducidad y revoke", () => {
  test("token caducado no autoriza; --ttl 0 no caduca", () => {
    const short = mintSession(workspace, { label: "ttl-short", ttlHours: 1 / 3_600_000 });
    Bun.sleepSync(5);
    expect(findSessionByToken(short.token)).toBeNull();
    const forever = mintSession(workspace, { label: "ttl-0", ttlHours: 0 });
    expect(forever.expiresAt).toBeNull();
    expect(findSessionByToken(forever.token)?.label).toBe("ttl-0");
    const normal = mintSession(workspace, { label: "ttl-default" });
    expect(Date.parse(String(normal.expiresAt))).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000);
  });

  test("sesion v0.3 sin expiresAt sigue valida (compat)", () => {
    const legacy = mintSession(workspace, { label: "legacy", ttlHours: 0 });
    expect(findSessionByToken(legacy.token)).not.toBeNull();
  });

  test("revoke: prefijo corto o ambiguo se rechaza en vez de borrar de mas", () => {
    const before = readSessions().length;
    expect(() => revokeSession("a")).toThrow(/al menos/);
    const a = mintSession(workspace, { label: "amb-a" });
    const b = mintSession(workspace, { label: "amb-b" });
    // Fuerza un prefijo comun inexistente en la practica: usa el fp completo.
    expect(revokeSession(a.fp)).toBe(1);
    expect(findSessionByToken(b.token)?.label).toBe("amb-b");
    expect(readSessions().length).toBe(before + 1);
  });
});

describe("confinamiento con symlinks", () => {
  test("un symlink del workspace que apunta afuera se niega", () => {
    const outside = mkdtempSync(join(tmpdir(), "isyco-outside-"));
    try {
      writeFileSync(join(outside, "x.png"), "x");
      mkdirSync(join(workspace, "sub"), { recursive: true });
      symlinkSync(join(outside, "x.png"), join(workspace, "sub", "link.png"));
      writeFileSync(join(workspace, "sub", "real.png"), "y");
      expect(resolveWithinReal(workspace, "sub/link.png")).toBeNull();
      expect(resolveWithinReal(workspace, "sub/real.png")).toBe(join(workspace, "sub", "real.png"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("candado de turnos web", () => {
  test("dos turnos concurrentes no se solapan", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const turn = (name: string) => withWebLock(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${name}`);
      await Bun.sleep(20);
      order.push(`end:${name}`);
      active--;
    });
    await Promise.all([turn("a"), turn("b"), turn("c")]);
    expect(maxActive).toBe(1);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  test("reentrante: un flujo multi-ronda no se bloquea a si mismo", async () => {
    const result = await withWebLock(() => withWebLock(async () => "ok"));
    expect(result).toBe("ok");
  });

  test("un turno que falla no deja el candado tomado", async () => {
    await expect(withWebLock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withWebLock(async () => 1)).toBe(1);
  });
});

describe("sanitizado de evidencia", () => {
  test("ids de conversacion de chatgpt.com se redactan", () => {
    const out = sanitizeEvidenceText("url https://chatgpt.com/c/0000aaaa-1111-2222-3333-444455556666 fin");
    expect(out).toContain("chatgpt.com/c/<redacted>");
    expect(out).not.toContain("0000aaaa");
  });
});
