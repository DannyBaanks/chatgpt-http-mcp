// never-guess-canary.test.ts — la captura no "adivina" y el canario detecta
// contaminacion entre turnos, markdown roto y bridge apagado.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNewAssistantTurn } from "../src/web-turn";
import { CANARY_TITLE, freePort, judge, readLatestCanary, runCanary } from "../src/canary";
import { listChats } from "../src/chats";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "isymcp-canary-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
});
afterAll(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("Never Guess: isNewAssistantTurn", () => {
  test("misma identidad y mismo texto = respuesta ANTERIOR -> se rechaza", () => {
    expect(isNewAssistantTurn("turn-7", "hola", "turn-7", "hola")).toBe(false);
  });
  test("identidad nueva aunque el texto se repita (OK dos veces) -> se acepta", () => {
    expect(isNewAssistantTurn("turn-7", "OK", "turn-8", "OK")).toBe(true);
  });
  test("misma identidad pero texto distinto (renderizando la nueva) -> se acepta", () => {
    expect(isNewAssistantTurn("turn-7", "viejo", "turn-7", "nuevo")).toBe(true);
  });
  test("sin turno previo (chat nuevo) -> cualquier texto es nuevo; vacio nunca", () => {
    expect(isNewAssistantTurn("", "", "turn-1", "hola")).toBe(true);
    expect(isNewAssistantTurn("turn-7", "x", "turn-8", "")).toBe(false);
  });
});

describe("canario: juicio de respuestas", () => {
  test("eco exacto, contaminado y markdown", () => {
    expect(judge("eco-a", "CANARY-A-1", { exact: "CANARY-A-1" }).ok).toBe(true);
    expect(judge("eco-a", "`CANARY-A-1`", { exact: "CANARY-A-1" }).ok).toBe(true);
    expect(judge("eco-b", "CANARY-A-1", { exact: "CANARY-B-2", absent: "CANARY-A-1" }).detail).toContain("CONTAMINADA");
    expect(judge("eco-a", "otra cosa", { exact: "CANARY-A-1" }).ok).toBe(false);
    expect(judge("markdown", "- uno\n- dos\n\n```bash\necho canario\n```", {}).ok).toBe(true);
    expect(judge("markdown", "uno\ndos\nbash\necho canario", {}).ok).toBe(false);
  });
});

describe("canario: corrida con turnos falsos", () => {
  // Bridge falso "sano": eco del texto pedido; markdown bien formado.
  const healthy = async (_chat: string, message: string) => {
    const nonce = /(CANARY-[AB]-\S+)/.exec(message)?.[1];
    if (nonce) return { ok: true, text: nonce };
    return { ok: true, text: "- uno\n- dos\n\n```bash\necho canario\n```" };
  };

  test("todo bien -> OK, un solo chat reutilizado, latest.json guardado", async () => {
    const r1 = await runCanary({ turn: healthy });
    const r2 = await runCanary({ turn: healthy });
    expect(r1.ok && r2.ok).toBe(true);
    expect(r1.checks.map((c) => c.name)).toEqual(["eco-a", "eco-b", "markdown"]);
    expect(listChats().filter((c) => c.title === CANARY_TITLE)).toHaveLength(1);
    expect(readLatestCanary()?.ts).toBe(r2.ts);
  });

  test("contaminacion: el turno B devuelve la respuesta de A -> FALLA", async () => {
    let last = "";
    const stale = async (_chat: string, message: string) => {
      const nonce = /(CANARY-[AB]-\S+)/.exec(message)?.[1];
      if (nonce?.startsWith("CANARY-A")) { last = nonce; return { ok: true, text: nonce }; }
      if (nonce) return { ok: true, text: last }; // captura rancia
      return { ok: true, text: "- a\n```bash\necho canario\n```" };
    };
    const r = await runCanary({ turn: stale });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "eco-b")!.detail).toContain("CONTAMINADA");
  });

  test("markdown roto (DOM cambio) -> FALLA en markdown", async () => {
    const flat = async (_chat: string, message: string) => {
      const nonce = /(CANARY-[AB]-\S+)/.exec(message)?.[1];
      return { ok: true, text: nonce ?? "uno\ndos\nBash\necho canario" };
    };
    const r = await runCanary({ turn: flat });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "markdown")!.ok).toBe(false);
  });

  test("bridge apagado sin permiso de levantar uno -> unavailable, guardado", async () => {
    const r = await runCanary({ port: "1", spawnBridge: false });
    expect(r).toMatchObject({ ok: false, bridge: "unavailable" });
    expect(readLatestCanary()?.bridge).toBe("unavailable");
  });
});

describe("canario: puerto del bridge temporal", () => {
  test("freePort devuelve un puerto que de verdad se puede abrir", () => {
    const port = freePort();
    expect(port).toBeGreaterThan(1024);
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
    expect(server.port).toBe(port);
    server.stop(true);
  });
});
