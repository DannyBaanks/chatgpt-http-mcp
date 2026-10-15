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
import { publicToolCard, readTraceSince, toolCards, tracePath, traceSize } from "../src/tool-trace";
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
  test("sanitiza recibos guardados antes de publicarlos sin perder campos seguros", () => {
    const turnToken = "TURN_SECRET_0123456789abcdef";
    const sessionToken = "SESSION_SECRET_0123456789abcdef";
    const apiKey = "API_SECRET_0123456789abcdef";
    const bearer = "BEARER_SECRET_0123456789abcdef";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signatureSECRET0123456789";
    const stdout = "OUTPUT_STDOUT_SECRET";
    const stderr = "OUTPUT_STDERR_SECRET";
    const genericToken = "GENERIC_TOKEN_SECRET_0123456789";
    const genericSecret = "GENERIC_SECRET_VALUE_0123456789";
    const colonSecret = "COLON_SECRET_VALUE_0123456789";
    const jsonStdout = "JSON_STDOUT_SECRET_0123456789";
    const jsonStderr = "JSON_STDERR_SECRET_0123456789";
    const nestedApiSecret = "NESTED_API_SECRET_0123456789";
    const nestedTokenSecret = "NESTED_TOKEN_SECRET_0123456789";
    const clientSecret = "CLIENT_SECRET_0123456789";
    const secretKey = "SECRET_KEY_0123456789";
    const privateKey = "PRIVATE_KEY_0123456789";
    const clientKey = "CLIENT_KEY_0123456789";
    const cliClientSecret = "CLI_CLIENT_SECRET_0123456789";
    const cliSecretKey = "CLI_SECRET_KEY_0123456789";
    const card = publicToolCard({
      tool: "codex_exec",
      summary: `git status turn_token=${turnToken}; session token: ${sessionToken}; api_key=${apiKey}; Authorization: Bearer ${bearer}; jwt ${jwt}; token=${genericToken}; secret: ${colonSecret}; client_secret=${clientSecret}; secret_key: ${secretKey}; --client-secret=${cliClientSecret}; --secret-key=${cliSecretKey}; {"secret":"${genericSecret}","client_secret":"${clientSecret}","secret_key":"${secretKey}","stdout":"${jsonStdout}","stderr":"${jsonStderr}"} {"stdout":{"nested":{"api_key":"${nestedApiSecret}","private_key":"${privateKey}","client_key":"${clientKey}"}},"stderr":[{"token":"${nestedTokenSecret}"}]} {"stdout":17,"stderr":null}`,
      state: "failed", exit_code: 2, duration_ms: 17, error: `--client-secret=${cliClientSecret}; {"stderr":"${stderr}","access_token":"${turnToken}","credential":"${genericSecret}","stdout":"${jsonStdout}","stderr":"${jsonStderr}"}`,
      stdout, stderr, token_fp: "PRIVATE_FP", call_id: "PRIVATE_CALL_ID", native_thread_id: "PRIVATE_THREAD_ID",
    });
    expect(card).toMatchObject({ tool: "codex_exec", state: "failed", exit_code: 2, duration_ms: 17 });
    expect(card?.summary).toContain("git status");
    expect(card?.summary).toContain('"stdout":"[stdout redacted]"');
    expect(card?.summary).toContain('"stderr":"[stderr redacted]"');
    expect(card?.summary).not.toContain('"stdout":{');
    expect(card?.summary).not.toContain('"stderr":[');
    expect(card?.summary).not.toContain('"stdout":17');
    expect(card?.summary).not.toContain('"stderr":null');
    expect(card?.error).toContain('"stderr":"[stderr redacted]"');
    expect(card).not.toHaveProperty("stdout");
    expect(card).not.toHaveProperty("stderr");
    const ordinaryCommand = publicToolCard({
      tool: "codex_exec", summary: "grep 'stdout: found' log && echo done", state: "ok",
    });
    expect(ordinaryCommand?.summary).toBe("grep 'stdout: found' log && echo done");
    const longCommand = `git status --short && ${"echo x".repeat(100)}`;
    expect(longCommand.length).toBeGreaterThan(500);
    expect(publicToolCard({ tool: "codex_exec", summary: longCommand, state: "ok" })?.summary).toBe(longCommand);
    const serialized = JSON.stringify(card);
    for (const secret of [turnToken, sessionToken, apiKey, bearer, jwt, stdout, stderr, genericToken, genericSecret, colonSecret, clientSecret, secretKey, privateKey, clientKey, cliClientSecret, cliSecretKey, jsonStdout, jsonStderr, nestedApiSecret, nestedTokenSecret, "PRIVATE_FP", "PRIVATE_CALL_ID", "PRIVATE_THREAD_ID"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("empareja por ID aunque la misma tool termine fuera de orden y proyecta solo campos seguros", () => {
    const events = [
      { ts: "2026-10-15T00:00:00.000Z", event: "call", data: { tool: "codex_exec", call_id: "call-a", token_fp: "secret-fp" } },
      { ts: "2026-10-15T00:00:00.001Z", event: "call", data: { tool: "codex_exec", call_id: "call-b", token_fp: "secret-fp" } },
      { ts: "2026-10-15T00:00:00.002Z", event: "tool.result", data: {
        tool: "codex_exec", call_id: "call-b", token_fp: "secret-fp", ok: true, command: "echo second",
        stdout: "STDOUT_SECRET", stderr: "STDERR_SECRET", native_thread_id: "NATIVE_THREAD_SECRET", exit_code: 0, duration_ms: 10,
      } },
      { ts: "2026-10-15T00:00:00.003Z", event: "tool.result", data: {
        tool: "codex_exec", call_id: "call-a", token_fp: "secret-fp", ok: false, command: "echo first",
        timed_out: true, error: "timeout", stdout: "STDOUT_SECRET", stderr: "STDERR_SECRET", token: "FULL_TOKEN_SECRET",
      } },
      { ts: "2026-10-15T00:00:00.004Z", event: "call", data: { tool: "codex_exec", call_id: "still-running", token_fp: "secret-fp" } },
    ];
    const cards = toolCards(events);
    expect(cards).toEqual([
      { tool: "codex_exec", summary: "echo first", state: "failed", correlation: "exact", error: "timeout" },
      { tool: "codex_exec", summary: "echo second", state: "ok", correlation: "exact", exit_code: 0, duration_ms: 10 },
      { tool: "codex_exec", summary: "", state: "running", correlation: "exact" },
    ]);
    const projection = JSON.stringify(cards);
    for (const secret of ["call-a", "call-b", "still-running", "secret-fp", "FULL_TOKEN_SECRET", "STDOUT_SECRET", "STDERR_SECRET", "NATIVE_THREAD_SECRET"]) {
      expect(projection).not.toContain(secret);
    }
    for (const field of ["token_fp", "token", "stdout", "stderr", "native_thread_id"]) {
      expect(projection).not.toContain(`\"${field}\"`);
    }
    expect(cards[1]).toHaveProperty("exit_code", 0);
    expect(cards[1]).toHaveProperty("duration_ms", 10);
  });

  test("conserva recibos historicos guardados y filtra sus campos al proyectar al navegador", () => {
    const chat = createChat();
    chat.messages.push({
      role: "assistant", text: "respuesta", ts: new Date().toISOString(),
      meta: { tools: [{
        tool: "codex_exec", summary: "git status", state: "ok", exit_code: 0, duration_ms: 20,
        token_fp: "LEGACY_TOKEN_FP", stdout: "LEGACY_STDOUT", stderr: "LEGACY_STDERR", native_thread_id: "LEGACY_NATIVE_THREAD",
      } as any] },
    });
    chat.messages.push({
      role: "assistant", text: "traza vieja malformada", ts: new Date().toISOString(),
      meta: { tools: { token_fp: "MALFORMED_SECRET" } as any },
    });
    saveChat(chat);
    const projected = publicChat(loadChat(chat.id)!, true);
    const receipt = (projected.messages?.[0]?.meta?.tools ?? [])[0];
    expect(receipt).toEqual({ tool: "codex_exec", summary: "git status", state: "ok", correlation: "legacy", exit_code: 0, duration_ms: 20 });
    expect(projected.messages?.[1]?.meta?.tools).toEqual([]);
    expect(JSON.stringify(projected)).not.toMatch(/LEGACY_(?:TOKEN_FP|STDOUT|STDERR|NATIVE_THREAD)/);
    expect(JSON.stringify(projected)).not.toContain("MALFORMED_SECRET");
  });

  test("solo el fp del turno, solo desde su offset; running -> ok/failed; sin contabilidad", () => {
    const path = join(home, "trace-test.log");
    writeFileSync(path, line("call", { tool: "codex_exec", token_fp: "aaa" }) + line("tool.result", { tool: "codex_exec", token_fp: "aaa", ok: true, command: "viejo", exit_code: 0 }));
    const offset = traceSize(path);
    appendFileSync(path,
      line("call", { tool: "codex_turn_start", token_fp: "aaa" })
      + line("call", { tool: "codex_exec", token_fp: "aaa" })
      + line("call", { tool: "codex_exec", token_fp: "bbb" })
      + line("tool.result", { tool: "codex_exec", token_fp: "bbb", ok: true, command: "OTRA SESION", exit_code: 0 }));
    expect(toolCards(readTraceSince(offset, "aaa", path))).toEqual([{ tool: "codex_exec", summary: "", state: "running", correlation: "legacy" }]);
    appendFileSync(path,
      line("tool.result", { tool: "codex_exec", token_fp: "aaa", ok: true, command: "git status", exit_code: 0, duration_ms: 420 })
      + line("call", { tool: "codex_exec", token_fp: "aaa" })
      + line("tool.result", { tool: "codex_exec", token_fp: "aaa", ok: true, command: "false", exit_code: 1, duration_ms: 3 })
      + line("tool.result", { tool: "codex_apply_patch", token_fp: "aaa", ok: true, files: ["a.txt"], exit_code: 0 })
      + "2026-10-07T00:00:00Z call {\"tool\":\"codex_exec\",\"token_fp\":\"aaa\"");
    const cards = toolCards(readTraceSince(offset, "aaa", path));
    expect(cards).toEqual([
      { tool: "codex_exec", summary: "git status", state: "ok", correlation: "legacy", exit_code: 0, duration_ms: 420 },
      { tool: "codex_exec", summary: "false", state: "failed", correlation: "legacy", exit_code: 1, duration_ms: 3 },
      { tool: "codex_apply_patch", summary: "a.txt", state: "ok", correlation: "legacy", exit_code: 0 },
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
      appendFileSync(tracePath(), line("call", { tool: "codex_exec", call_id: "synthetic-call", token_fp: fp })
        + line("tool.result", { tool: "codex_exec", call_id: "synthetic-call", token_fp: fp, ok: true, command: "echo hola", exit_code: 0, duration_ms: 12 })
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
    expect(s.statusTools).toEqual([{ tool: "codex_exec", summary: "echo hola", state: "ok", correlation: "exact", exit_code: 0, duration_ms: 12 }]);
    const tok = /turn_token: (\S+)/.exec(s.prompt)![1]!;
    expect(findSessionByToken(tok)).toBeNull();
    expect(out.ok).toBe(true);
    expect(out.reply.meta?.tools).toEqual([{ tool: "codex_exec", summary: "echo hola", state: "ok", correlation: "exact", exit_code: 0, duration_ms: 12 }]);
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
    const staleConfig = createChat();
    staleConfig.tools_enabled = true;
    staleConfig.session_fp = expired.fp;
    saveChat(staleConfig);
    const disabled = await post(staleConfig.id, { tools_enabled: false, session_fp: expired.fp });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ tools_enabled: false });
    expect(loadChat(staleConfig.id)).toMatchObject({ tools_enabled: false, session_fp: expired.fp });
    const ok = mintSession(ws, { label: "ok" });
    const res = await post(chat.id, { tools_enabled: true, session_fp: ok.fp });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ tools_enabled: true });
    expect(body).not.toHaveProperty("session_fp");
    expect(JSON.stringify(body)).not.toContain(ok.token);
    expect(JSON.stringify(publicSessions())).not.toContain(ok.token);
    expect(JSON.stringify(publicSessions())).not.toContain("token\"");
    const off = await (await post(chat.id, { tools_enabled: false })).json() as Record<string, unknown>;
    expect(off.tools_enabled).toBe(false);
  });

  test("oculta session_fp en metadatos de lista y conserva el selector opaco en el detalle", () => {
    const session = mintSession(ws, { label: "private-selector" });
    const chat = createChat();
    chat.session_fp = session.fp;
    saveChat(chat);
    const list = publicChat(chat, false);
    const detail = publicChat(chat, true);
    expect(list).not.toHaveProperty("session_fp");
    expect(detail.session_fp).toBe(session.fp);
    expect(JSON.stringify(detail)).not.toContain(session.token);
  });
});

describe("MCP real: tool.result por turno", () => {
  test("codex_tool_inventory conserva el ID de llamada hasta tool.result sin exponerlo en la tarjeta", async () => {
    const parent = mintSession(ws, { label: "mcp-p2" });
    const turn = mintTurnToken(parent.fp, "chat:abcd");
    const offset = traceSize();
    const res = await callMcpTool(home, "codex_tool_inventory", { turn_token: turn.token });
    expect(res.source).toBe("codex-web-http sessions");
    const events = readTraceSince(offset, turn.fp);
    const call = events.find((e) => e.event === "call");
    const result = events.find((e) => e.event === "tool.result");
    expect(typeof call?.data.call_id).toBe("string");
    expect(result?.data.call_id).toBe(call?.data.call_id);
    expect(result?.data).toMatchObject({ tool: "codex_tool_inventory", turn_id: "chat:abcd" });
    expect(result?.data).not.toHaveProperty("stdout");
    expect(result?.data).not.toHaveProperty("stderr");
    expect(toolCards(events)).toEqual([{ tool: "codex_tool_inventory", summary: "", state: "ok", correlation: "exact" }]);
    // La respuesta MCP no contiene salida capturada ni el token completo.
    const raw = readFileSync(tracePath(), "utf8").slice(offset);
    expect(raw).not.toContain(turn.token);
  });

  test("redacta el token completo si aparece dentro del error de una tool", async () => {
    const parent = mintSession(ws, { label: "mcp-redaction" });
    const turn = mintTurnToken(parent.fp, "chat:redaction");
    const traceSecrets = [
      "TRACE_CLIENT_SECRET_0123456789",
      "TRACE_SECRET_KEY_0123456789",
      "TRACE_CLIENT_KEY_0123456789",
      "TRACE_PRIVATE_KEY_0123456789",
    ];
    const badPath = `${turn.token}; --client_secret=${traceSecrets[0]}; --secret_key=${traceSecrets[1]}; {"client_key":"${traceSecrets[2]}","private_key":"${traceSecrets[3]}"}`;
    const offset = traceSize();
    await callMcpTool(home, "codex_view_image", { turn_token: turn.token, path: badPath });
    const events = readTraceSince(offset, turn.fp);
    const call = events.find((e) => e.event === "call");
    const result = events.find((e) => e.event === "tool.result");
    expect(typeof call?.data.call_id).toBe("string");
    expect(result?.data.call_id).toBe(call?.data.call_id);
    expect(result?.data.error).toContain("[token redacted]");
    const raw = readFileSync(tracePath(), "utf8").slice(offset);
    expect(raw).not.toContain(turn.token);
    for (const secret of traceSecrets) expect(raw).not.toContain(secret);
    const card = toolCards(events)[0];
    expect(card?.state).toBe("failed");
    expect(JSON.stringify(card)).not.toContain(call?.data.call_id as string);
    expect(JSON.stringify(card)).not.toContain(turn.token);
  });
});
