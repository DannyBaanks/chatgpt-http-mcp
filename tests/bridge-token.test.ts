// bridge-token.test.ts — FS-01: el bridge siempre exige token, y el token se
// crea y se guarda solo (0600) para que panel, MCP, canario y CLI no pidan nada.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, statSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { bridgeAuthHeaders, bridgeToken, TOKEN_HEADER } from "../src/local-guard";
import { createHandler, startServer } from "../src/server";

const roots: string[] = [];
function tempRoot(prefix = "isymcp-token-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const posix = process.platform !== "win32";

describe("token persistido del bridge", () => {
  test("se crea en el primer uso con 0600 y se reutiliza", () => {
    const home = join(tempRoot(), "home");
    const env = { CODEX_WEB_HTTP_HOME: home };
    const first = bridgeToken(env);
    expect(first.length).toBeGreaterThanOrEqual(20);
    expect(first).toBe(readFileSync(join(home, "token"), "utf8").trim());
    expect(bridgeToken(env)).toBe(first);
    if (posix) {
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, "token")).mode & 0o777).toBe(0o600);
    }
  });

  test("un token con permisos abiertos se endurece al leerlo", () => {
    if (!posix) return;
    const home = tempRoot();
    writeFileSync(join(home, "token"), `${"a".repeat(43)}\n`, { mode: 0o644 });
    chmodSync(join(home, "token"), 0o644);
    const token = bridgeToken({ CODEX_WEB_HTTP_HOME: home });
    expect(token).toBe("a".repeat(43));
    expect(statSync(join(home, "token")).mode & 0o777).toBe(0o600);
  });

  test("CODEX_WEB_HTTP_TOKEN manda y no toca el disco", () => {
    const home = tempRoot();
    const token = bridgeToken({ CODEX_WEB_HTTP_HOME: home, CODEX_WEB_HTTP_TOKEN: "explicit-token" });
    expect(token).toBe("explicit-token");
    expect(() => readFileSync(join(home, "token"))).toThrow();
  });

  test("un token invalido o un symlink se rechazan en vez de regenerarse", () => {
    const bad = tempRoot();
    writeFileSync(join(bad, "token"), "corto\n");
    expect(() => bridgeToken({ CODEX_WEB_HTTP_HOME: bad })).toThrow(/invalido/);

    const linked = tempRoot();
    const target = join(linked, "real-token");
    writeFileSync(target, `${"b".repeat(43)}\n`, { mode: 0o600 });
    if (posix) chmodSync(target, 0o600);
    symlinkSync(target, join(linked, "token"));
    expect(() => bridgeToken({ CODEX_WEB_HTTP_HOME: linked })).toThrow(/archivo real/);
  });
});

describe("el bridge no responde sin token", () => {
  const config = loadConfig({ CODEX_WEB_HTTP_WEB_MODELS: "on", CODEX_WEB_HTTP_UPSTREAM: "http://127.0.0.1:9" });

  test("/isymcp/* y el upgrade websocket dan 401 sin x-isymcp-token", async () => {
    const home = join(tempRoot(), "home");
    const previous = process.env.CODEX_WEB_HTTP_HOME;
    process.env.CODEX_WEB_HTTP_HOME = home;
    try {
      const handler = createHandler(config);
      for (const path of ["/isymcp/metrics", "/v1/models"]) {
        expect((await handler(new Request(`http://127.0.0.1:8791${path}`))).status).toBe(401);
      }
      const upgrade = await handler(new Request("http://127.0.0.1:8791/v1/responses", {
        headers: { upgrade: "websocket" },
      }));
      expect(upgrade.status).toBe(401);

      const headers = { [TOKEN_HEADER]: bridgeToken({ CODEX_WEB_HTTP_HOME: home }) };
      expect((await handler(new Request("http://127.0.0.1:8791/isymcp/metrics", { headers }))).status).toBe(200);
      const withToken = await handler(new Request("http://127.0.0.1:8791/v1/responses", {
        headers: { ...headers, upgrade: "websocket" },
      }));
      expect(withToken.status).toBe(426);
      expect(bridgeAuthHeaders()[TOKEN_HEADER]).toBe(headers[TOKEN_HEADER]);
    } finally {
      if (previous === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
      else process.env.CODEX_WEB_HTTP_HOME = previous;
    }
  });

  test("si el token no se puede preparar responde 503, no queda abierto", async () => {
    const previous = process.env.CODEX_WEB_HTTP_HOME;
    const file = join(tempRoot(), "not-a-dir");
    writeFileSync(file, "x");
    process.env.CODEX_WEB_HTTP_HOME = file;
    try {
      const res = await createHandler(config)(new Request("http://127.0.0.1:8791/health"));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { type: string } }).error.type).toBe("bridge_token_unavailable");
    } finally {
      if (previous === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
      else process.env.CODEX_WEB_HTTP_HOME = previous;
    }
  });

  test("startServer real: 401 sin token y 200 con el token del bridge", async () => {
    const home = join(tempRoot(), "home");
    const previousHome = process.env.CODEX_WEB_HTTP_HOME;
    const previousToken = process.env.CODEX_WEB_HTTP_TOKEN;
    process.env.CODEX_WEB_HTTP_HOME = home;
    delete process.env.CODEX_WEB_HTTP_TOKEN;
    const server = startServer(loadConfig({ CODEX_WEB_HTTP_PORT: "0", CODEX_WEB_HTTP_WEB_MODELS: "on" }));
    try {
      const url = `http://127.0.0.1:${server.port}/isymcp/metrics`;
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: bridgeAuthHeaders() })).status).toBe(200);
    } finally {
      server.stop(true);
      if (previousHome === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
      else process.env.CODEX_WEB_HTTP_HOME = previousHome;
      if (previousToken === undefined) delete process.env.CODEX_WEB_HTTP_TOKEN;
      else process.env.CODEX_WEB_HTTP_TOKEN = previousToken;
    }
  });
});
