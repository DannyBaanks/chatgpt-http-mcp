// M5 (P0): exactly-once por turno — semantica del guard con ejecutor inyectado.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIdempotent } from "../src/turn-idempotency";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "isyco-turn-home-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
});
afterEach(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(home, { recursive: true, force: true });
});

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

describe("M5: idempotencia por turno", () => {
  test("sin turn id: no cachea ni cambia el comportamiento", async () => {
    let calls = 0;
    await runIdempotent(null, async () => {
      calls++;
      return json("{}");
    });
    expect(calls).toBe(1);
    expect(existsSync(join(home, "turns"))).toBe(false);
  });

  test("mismo id dos veces: UNA sola ejecucion y misma respuesta", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return json('{"ok":1}');
    };
    const first = await runIdempotent("turn-abc-123", run);
    const second = await runIdempotent("turn-abc-123", run);
    expect(calls).toBe(1);
    expect(await first.text()).toBe('{"ok":1}');
    expect(await second.text()).toBe('{"ok":1}');
    expect(first.headers.get("x-isymcp-replayed")).toBe("0");
    expect(second.headers.get("x-isymcp-replayed")).toBe("1");
  });

  test("duplicado EN VUELO: una sola ejecucion (promesa compartida)", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      await Bun.sleep(50);
      return json('{"slow":1}');
    };
    const [a, b] = await Promise.all([
      runIdempotent("turn-slow-1", run),
      runIdempotent("turn-slow-1", run),
    ]);
    expect(calls).toBe(1);
    expect(await a.text()).toBe('{"slow":1}');
    expect(await b.text()).toBe('{"slow":1}');
  });

  test("id con traversal: el archivo queda en turns/ con hash y 0600", async () => {
    await runIdempotent("../../etc/passwd", async () => json("x"));
    const dir = join(home, "turns");
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^[a-f0-9]{32}\.json$/);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
  });

  test("5xx NO se cachea (ambiguo: retry permitido)", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return json('{"error":"boom"}', 500);
    };
    await runIdempotent("turn-5xx", run);
    await runIdempotent("turn-5xx", run);
    expect(calls).toBe(2);
  });

  test("4xx SI se cachea (resultado definitivo)", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return json('{"error":"bad"}', 400);
    };
    await runIdempotent("turn-4xx", run);
    const second = await runIdempotent("turn-4xx", run);
    expect(calls).toBe(1);
    expect(second.status).toBe(400);
    expect(second.headers.get("x-isymcp-replayed")).toBe("1");
  });
});
