// chat-phase2-tools.test.ts — Fase 2: tools en el chat local.
//
// Invariantes:
//   - a chatgpt.com solo viaja un token EFIMERO de turno (nunca el de sesion);
//   - el token de turno muere al terminar el turno y con su sesion padre;
//   - las tarjetas de tool salen de mcp-trace filtrado por el fp de ESE turno
//     (no por ventana de tiempo) y nunca traen stdout;
//   - el navegador nunca ve tokens.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSessionByToken, fingerprint, listUserSessions, mintSession, mintTurnToken, readSessions, revokeSession, revokeTurnToken,
} from "../src/codex-sessions";
import { readTraceSince, toolCards, tracePath, traceSize } from "../src/tool-trace";
import { createChat, loadChat, publicChat, saveChat } from "../src/chats";
import { chatStatus, runChatTurn } from "../src/chat-turn";
import { loadConfig } from "../src/config";
import { handleChatApi, publicSessions } from "../src/panel";
import type { WebTurnOptions, WebTurnResult } from "../src/web-turn";
import { callMcpTool } from "./helpers/mcp-call";

let home: string;
let ws: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "isymcp-p2-"));
  ws = mkdtempSync(join(tmpdir(), "isymcp-p2-ws-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
});
afterAll(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});
const config = loadConfig({});
const line = (event: string, data: Record<string, unknown>) => `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`;

describe("tokens de turno", () => {
  test("heredan cwd/modo, caducan en minutos y no aparecen en los listados", () => {
    const parent = mintSession(ws, { label: "p", writable: true });
    const turn = mintTurnToken(parent.fp, "t1");
    expect(turn.cwd).toBe(parent.cwd);
    expect(turn.writable).toBe(true);
    expect(turn.parent).toBe(parent.fp);
    expect(Date.parse(String(turn.expiresAt)) - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 1000);
    expect(findSessionByToken(turn.token)?.turnId).toBe("t1");
    expect(listUserSessions().some((x) => x.fp === turn.fp)).toBe(false);
    expect(publicSessions().sessions.some((x) => x.fp === turn.fp)).toBe(false);
    revokeTurnToken(turn.fp);
    expect(findSessionByToken(turn.token)).toBeNull();
  });

  test("mueren con su sesion padre (revoke en cascada / padre caducado)", () => {
    const parent = mintSession(ws, { label: "cascada" });
    const turn = mintTurnToken(parent.fp, "t2");
    expect(revokeSession(parent.fp)).toBe(1);
    expect(findSessionByToken(turn.token)).toBeNull();
    expect(readSessions().some((x) => x.fp === turn.fp)).toBe(false);

    const short = mintSession(ws, { label: "corta", ttlHours: 1 / 3_600_000 });
    expect(() => { Bun.sleepSync(5); mintTurnToken(short.fp, "t3"); }).toThrow(/caduco/);
  });

  test("un token de turno no puede acuñar otro ni hacerse pasar por sesion", () => {
    const parent = mintSession(ws, { label: "p2" });
    const turn = mintTurnToken(parent.fp, "t4");
    expect(() => mintTurnToken(turn.fp, "t5")).toThrow(/desconocida/);
  });
});

describe("traza -> tarjetas", () => {
  test("solo el fp del turno, solo desde su offset; running -> ok/failed; sin contabilidad", () => {
    const path = join(home, "trace-test.log");
    writeFileSync(path, line("call", { tool: "codex_exec", token_fp: "aaa" }) + line("tool.result", { tool: "codex_exec", token_fp: "aaa", ok: true, command: "viejo", exit_code: 0 }));
    const offset = traceSize(path);
    appendFileSync(path,
      line("call", { tool: "codex_turn_start", token_fp: "aaa" })
      + line("call", { tool: "codex_exec", token_fp: "aaa" })
      + line("call", { tool: "codex_exec", token_fp: "bbb" })
      + line("tool.result", { tool: "codex_exec", token_fp: "bbb", ok: true, command: "OTRA SESION", exit_code: 0 }));
    expect(toolCards(readTraceSince(offset, "aaa", path))).toEqual([{ tool: "codex_exec", summary: "", state: "running" }]);
    appendFileSync(path,
      line("tool.result", { tool: "codex_exec", token_fp: "aaa", ok: true, command: "git status", exit_code: 0, duration_ms: 420 })
      + line("call", { tool: "codex_exec", token_fp: "aaa" })
      + line("tool.result", { tool: "codex_exec", token_fp: "aaa", ok: true, command: "false", exit_code: 1, duration_ms: 3 })
      + line("tool.result", { tool: "codex_apply_patch", token_fp: "aaa", ok: true, files: ["a.txt"], exit_code: 0 })
      + "2026-10-07T00:00:00Z call {\"tool\":\"codex_exec\",\"token_fp\":\"aaa\"");
    const cards = toolCards(readTraceSince(offset, "aaa", path));
    expect(cards).toEqual([
      { tool: "codex_exec", summary: "git status", state: "ok", exit_code: 0, duration_ms: 420 },
      { tool: "codex_exec", summary: "false", state: "failed", exit_code: 1, duration_ms: 3 },
      { tool: "codex_apply_patch", summary: "a.txt", state: "ok", exit_code: 0 },
    ]);
  });
});

describe("turno de chat con tools", () => {
  test("token efimero en el prompt, conector seleccionado, tarjetas de la traza, token revocado al final", async () => {
    const session = mintSession(ws, { label: "chat-rw", writable: true });
    const chat = createChat();
    chat.tools_enabled = true;
    chat.session_fp = session.fp;
    saveChat(chat);
    mkdirSync(home, { recursive: true });
    let seen: { prompt: string; connector?: string; tokenValidDuring: boolean; statusTools?: unknown } | null = null;
    const send = async (prompt: string, options: WebTurnOptions): Promise<WebTurnResult> => {
      const tok = /turn_token: (\S+)/.exec(prompt)?.[1] ?? "";
      const fp = fingerprint(tok);
      // Simula al MCP: llamada + resultado de ESTE turno, y ruido de otra sesion.
      appendFileSync(tracePath(), line("call", { tool: "codex_exec", token_fp: fp })
        + line("tool.result", { tool: "codex_exec", token_fp: fp, ok: true, command: "echo hola", exit_code: 0, duration_ms: 12 })
        + line("tool.result", { tool: "codex_exec", token_fp: "otro000000aa", ok: true, command: "NO MIO", exit_code: 0 }));
      await Bun.sleep(1000); // deja correr el sondeo en vivo
      seen = { prompt, connector: options.connector, tokenValidDuring: findSessionByToken(tok) !== null, statusTools: chatStatus().tools };
      return { text: "hola", ms: 1, submitted: true, reused: true, url: "https://chatgpt.com/c/70010000-aaaa-bbbb-cccc-dddddddddddd" };
    };
    const out = await runChatTurn(chat.id, "ejecuta echo hola", config, { send });
    const s = seen!;
    expect(s.prompt).toContain("COMANDO: @CODEX ISYMCP");
    expect(s.prompt).toContain("ejecuta echo hola");
    expect(s.prompt).not.toContain(session.token);
    expect(s.connector).toBe("Codex ISyMCP");
    expect(s.tokenValidDuring).toBe(true);
    expect(s.statusTools).toEqual([{ tool: "codex_exec", summary: "echo hola", state: "ok", exit_code: 0, duration_ms: 12 }]);
    const tok = /turn_token: (\S+)/.exec(s.prompt)![1]!;
    expect(findSessionByToken(tok)).toBeNull();
    expect(out.ok).toBe(true);
    expect(out.reply.meta?.tools).toEqual([{ tool: "codex_exec", summary: "echo hola", state: "ok", exit_code: 0, duration_ms: 12 }]);
    // Lo guardado es el mensaje del usuario, no el comando con el token.
    const stored = loadChat(chat.id)!;
    expect(stored.messages[0]!.text).toBe("ejecuta echo hola");
    expect(JSON.stringify(stored)).not.toContain(tok);
    expect(JSON.stringify(publicChat(stored, true))).not.toContain(session.token);
  });

  test("sesion borrada -> error tools_session sin enviar nada a ChatGPT", async () => {
    const session = mintSession(ws, { label: "se-va" });
    const chat = createChat();
    chat.tools_enabled = true;
    chat.session_fp = session.fp;
    saveChat(chat);
    revokeSession(session.fp);
    let called = false;
    const out = await runChatTurn(chat.id, "hola", config, { send: async () => { called = true; throw new Error("no"); } });
    expect(called).toBe(false);
    expect(out.reply.meta?.kind).toBe("tools_session");
  });

  test("tools apagadas -> mensaje plano y sin conector", async () => {
    const chat = createChat();
    let got: { prompt: string; connector?: string } | null = null;
    await runChatTurn(chat.id, "solo texto", config, { send: async (prompt, o) => {
      got = { prompt, connector: o.connector };
      return { text: "ok", ms: 1, submitted: true, reused: true, url: "https://chatgpt.com/c/70020000-aaaa-bbbb-cccc-dddddddddddd" };
    } });
    expect(got!).toEqual({ prompt: "solo texto", connector: "" });
  });
});

describe("API del panel", () => {
  const post = (id: string, body: unknown) => {
    const url = new URL(`http://127.0.0.1/api/chats/${id}/config`);
    return handleChatApi(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url, "1");
  };
  test("encender exige sesion vigente; el chat nuevo nace apagado; nada de tokens", async () => {
    const chat = createChat();
    expect(publicChat(chat, false).tools_enabled).toBe(false);
    expect((await post(chat.id, { tools_enabled: true, session_fp: null })).status).toBe(400);
    expect((await post(chat.id, { tools_enabled: true, session_fp: "nonexistent0" })).status).toBe(400);
    const expired = mintSession(ws, { label: "exp", ttlHours: 1 / 3_600_000 });
    Bun.sleepSync(5);
    expect((await post(chat.id, { tools_enabled: true, session_fp: expired.fp })).status).toBe(400);
    const ok = mintSession(ws, { label: "ok" });
    const res = await post(chat.id, { tools_enabled: true, session_fp: ok.fp });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ tools_enabled: true, session_fp: ok.fp });
    expect(JSON.stringify(body)).not.toContain(ok.token);
    expect(JSON.stringify(publicSessions())).not.toContain(ok.token);
    expect(JSON.stringify(publicSessions())).not.toContain("token\"");
    const off = await (await post(chat.id, { tools_enabled: false })).json() as Record<string, unknown>;
    expect(off.tools_enabled).toBe(false);
  });
});

describe("MCP real: tool.result por turno", () => {
  test("codex_exec con token de turno deja tool.result con turn_id y sin stdout", async () => {
    const parent = mintSession(ws, { label: "mcp-p2" });
    const turn = mintTurnToken(parent.fp, "chat:abcd");
    const offset = traceSize();
    const res = await callMcpTool(home, "codex_exec", { turn_token: turn.token, command: ["echo", "SALIDA-SECRETA-DEL-COMANDO"] });
    expect(res.executed).toBe(true);
    const events = readTraceSince(offset, turn.fp);
    const result = events.find((e) => e.event === "tool.result");
    expect(result?.data).toMatchObject({ tool: "codex_exec", turn_id: "chat:abcd", exit_code: 0, command: "echo SALIDA-SECRETA-DEL-COMANDO" });
    // El argumento si (es lo que se ejecuto); la SALIDA no.
    const raw = readFileSync(tracePath(), "utf8").slice(offset);
    expect(raw.split("SALIDA-SECRETA-DEL-COMANDO").length - 1).toBe(1);
    expect(raw).not.toContain(turn.token);
  });
});
