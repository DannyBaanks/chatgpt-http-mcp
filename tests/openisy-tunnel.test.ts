// tests/openisy-tunnel.test.ts — Pruebas del túnel bidireccional OpenISy y control de TUIs en tmux.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchIsyMcpAction } from "../src/mcp/gateway";
import { parseModelRef } from "../src/openisy-tunnel";
import { sendKeysToTmux, sendRawToTmux } from "../src/console-delivery";

describe("OpenISy Tunnel & TUI Control", () => {
  let server: ReturnType<typeof Bun.serve>;
  let serverUrl: string;
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};
  const recordedRequests: Array<{ method: string; path: string; body: any }> = [];

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "openisy-tunnel-test-"));
    for (const k of ["CODEX_WEB_HTTP_HOME", "ISYMCP_ALLOW_AGENT_SPAWN"]) savedEnv[k] = process.env[k];
    process.env.CODEX_WEB_HTTP_HOME = home;
    delete process.env.ISYMCP_ALLOW_AGENT_SPAWN;

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const auth = req.headers.get("authorization");
        if (auth !== `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        const body = req.method === "GET" ? null : await req.json().catch(() => null);
        recordedRequests.push({ method: req.method, path: url.pathname, body });

        if (url.pathname === "/api/info") {
          return Response.json({ version: "2.0.32-openisy", pid: 99999 });
        }
        if (url.pathname === "/api/session/active") {
          return Response.json({ data: { ses_live_main: { type: "running" } } });
        }
        if (url.pathname === "/api/session" && req.method === "GET") {
          return Response.json({
            data: [
              {
                id: "ses_live_main",
                title: "Sesión principal de Danny",
                agent: "build",
                model: { providerID: "nvidia", id: "minimaxai/minimax-m3.1-flash", variant: "thinking" },
                outcome: "succeeded",
                location: { directory: "/srv/work/isyco" },
                time: { updated: 1000 },
              },
            ],
          });
        }
        if (url.pathname === "/api/agent") {
          return Response.json({
            data: [
              { id: "build", name: "Build", mode: "primary", hidden: false, description: "Primary builder" },
              { id: "explore", name: "Explore", mode: "subagent", hidden: false, description: "Fast explorer" },
              { id: "general", name: "General", mode: "subagent", hidden: false, description: "General subagent" },
            ],
          });
        }
        if (url.pathname === "/api/session" && req.method === "POST") {
          return Response.json({
            data: {
              id: "ses_child_sub01",
              parentID: body?.parentID ?? null,
              title: body?.title,
              agent: body?.agent,
              model: body?.model,
            },
          });
        }
        if (url.pathname.endsWith("/prompt") && req.method === "POST") {
          return Response.json({ admitted: true, delivery: body?.delivery ?? "default" });
        }
        if (url.pathname.endsWith("/synthetic") && req.method === "POST") {
          return Response.json({ admitted: true, type: "synthetic" });
        }
        if (url.pathname.endsWith("/wait") && req.method === "POST") {
          return Response.json({ idle: true });
        }
        if (url.pathname.endsWith("/environment") && req.method === "PUT") {
          return Response.json({ updated: true });
        }
        if (url.pathname.endsWith("/agent") && req.method === "POST") {
          return Response.json({ agent: body?.agent });
        }
        if (url.pathname.endsWith("/model") && req.method === "POST") {
          return Response.json({ model: body?.model });
        }
        if (url.pathname.endsWith("/permission") && req.method === "GET") {
          return Response.json({ data: [{ id: "perm_01", action: "shell", resource: "git status" }] });
        }
        if (url.pathname.includes("/permission/") && url.pathname.endsWith("/reply") && req.method === "POST") {
          return Response.json({ replied: true, decision: body?.decision });
        }
        if (url.pathname.endsWith("/form") && req.method === "GET") {
          return Response.json({ data: [] });
        }
        if (url.pathname.endsWith("/inbox") && req.method === "GET") {
          return Response.json({ data: [] });
        }
        if (url.pathname.endsWith("/message") && req.method === "GET") {
          return Response.json({
            data: [
              {
                id: "msg_ast_01",
                type: "assistant",
                agent: "explore",
                model: { providerID: "xkiro", id: "x-ai/grok-4.5" },
                content: [
                  { type: "reasoning", text: "Buscando módulos..." },
                  { type: "text", text: "Reporte del sub-agente completado con éxito." },
                ],
                time: { created: 2000 },
              },
            ],
          });
        }
        if (url.pathname.startsWith("/api/session/")) {
          const id = url.pathname.split("/")[3];
          return Response.json({
            data: {
              id,
              parentID: id === "ses_child_sub01" ? "ses_live_main" : null,
              title: "Test Session",
              agent: "explore",
              model: { providerID: "xkiro", id: "x-ai/grok-4.5" },
              outcome: "succeeded",
              location: { directory: "/srv/work/isyco" },
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    serverUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("OT-01: parseModelRef soporta provider/model#variant, provider explícito y objetos", () => {
    expect(parseModelRef("xkiro/x-ai/grok-4.5#thinking")).toEqual({
      providerID: "xkiro",
      id: "x-ai/grok-4.5",
      variant: "thinking",
    });
    expect(parseModelRef("claude-sonnet-4-5", "freellmapi")).toEqual({
      providerID: "freellmapi",
      id: "claude-sonnet-4-5",
    });
    expect(parseModelRef({ providerID: "nvidia", id: "mistralai/mistral-large-4-1t-a52b" })).toEqual({
      providerID: "nvidia",
      id: "mistralai/mistral-large-4-1t-a52b",
    });
  });

  it("OT-02: sendRawToTmux y sendKeysToTmux ejecutan la secuencia exacta sin cabecera ChatGPT", () => {
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const r1 = sendRawToTmux("sock1", "sess1", "/compact", true, (argv, stdin) => {
      calls.push({ argv, stdin });
      return { code: 0, err: "" };
    });
    expect(r1.delivered).toBe(true);
    expect(calls.map((c) => c.argv.slice(3, 5))).toEqual([
      ["has-session", "-t"],
      ["load-buffer", "-b"],
      ["paste-buffer", "-p"],
      ["send-keys", "-t"],
    ]);
    expect(calls[1]?.stdin).toBe("/compact");

    const keyCalls: string[][] = [];
    const r2 = sendKeysToTmux("sock1", "sess1", ["Escape", "Enter"], (argv) => {
      keyCalls.push(argv);
      return { code: 0, err: "" };
    });
    expect(r2.delivered).toBe(true);
    expect(keyCalls[1]).toEqual(["tmux", "-L", "sock1", "send-keys", "-t", "sess1", "Escape", "Enter"]);
  });

  it("OT-03: lecturas (openisy.sessions, openisy.messages) funcionan sin permiso agent_spawn, pero mutaciones exigen checkGate", async () => {
    delete process.env.ISYMCP_ALLOW_AGENT_SPAWN;
    const overview = await dispatchIsyMcpAction("openisy.sessions", {
      server_url: serverUrl,
      password: "test-secret",
    });
    expect(overview.ok).toBe(true);
    expect((overview.result as any).active_sessions.ses_live_main).toBeDefined();

    const msgs = await dispatchIsyMcpAction("openisy.messages", {
      server_url: serverUrl,
      password: "test-secret",
      session_id: "active",
    });
    expect(msgs.ok).toBe(true);
    expect((msgs.result as any).session.id).toBe("ses_live_main");
    expect((msgs.result as any).messages[0].text).toContain("Reporte del sub-agente");

    const deniedSend = await dispatchIsyMcpAction("openisy.send", {
      server_url: serverUrl,
      password: "test-secret",
      text: "Hola desde AGY",
    });
    expect(deniedSend.ok).toBe(false);
    expect(deniedSend.error).toContain("DENIED");
  });

  it("OT-04: con agent_spawn activo, openisy.send (user/synthetic), openisy.control y openisy.subagent orquestan la TUI y sub-agentes", async () => {
    process.env.ISYMCP_ALLOW_AGENT_SPAWN = "1";
    recordedRequests.length = 0;

    // 1. Enviar mensaje como usuario con steer + mención de sub-agente
    const sendUser = await dispatchIsyMcpAction("openisy.send", {
      server_url: serverUrl,
      password: "test-secret",
      session_id: "active",
      as: "user",
      delivery: "steer",
      text: "Revisa el módulo con explore",
      agents: ["explore"],
    });
    expect(sendUser.ok).toBe(true);
    expect((sendUser.result as any).session_id).toBe("ses_live_main");
    const promptReq = recordedRequests.find((r) => r.path === "/api/session/ses_live_main/prompt");
    expect(promptReq?.body).toEqual({
      text: "Revisa el módulo con explore",
      delivery: "steer",
      agents: [{ name: "explore" }],
    });

    // 2. Inyectar turno sintético como si fuera el agente de la TUI
    const sendSynth = await dispatchIsyMcpAction("openisy.send", {
      server_url: serverUrl,
      password: "test-secret",
      session_id: "ses_live_main",
      as: "synthetic",
      text: "[Contexto inyectado por AGY]",
      resume: false,
    });
    expect(sendSynth.ok).toBe(true);
    const synthReq = recordedRequests.find((r) => r.path === "/api/session/ses_live_main/synthetic");
    expect(synthReq?.body).toEqual({
      text: "[Contexto inyectado por AGY]",
      resume: false,
    });

    // 3. Controlar la TUI: cambiar modelo y aprobar permisos pendientes
    const ctrl = await dispatchIsyMcpAction("openisy.control", {
      server_url: serverUrl,
      password: "test-secret",
      session_id: "ses_live_main",
      model: "xkiro/x-ai/grok-4.5",
      approve_permissions: "once",
    });
    expect(ctrl.ok).toBe(true);
    const actions = (ctrl.result as any).actions;
    expect(actions.map((a: any) => a.op)).toEqual(["switch_model", "permission_reply"]);

    // 4. Despachar un sub-agente colgado de la sesión principal con API key efímera
    const sub = await dispatchIsyMcpAction("openisy.subagent", {
      server_url: serverUrl,
      password: "test-secret",
      attach_to_active: true,
      agent: "explore",
      model: "xkiro/x-ai/grok-4.5",
      api_key: "sk-ephemeral-123",
      api_key_env: "XKIRO_API_KEY",
      prompt: "Audita los endpoints",
      wait: true,
    });
    expect(sub.ok).toBe(true);
    const subRes = sub.result as any;
    expect(subRes.session_id).toBe("ses_child_sub01");
    expect(subRes.parent_session_id).toBe("ses_live_main");
    expect(subRes.assistant_text).toBe("Reporte del sub-agente completado con éxito.");
    const envReq = recordedRequests.find((r) => r.path === "/api/session/ses_child_sub01/environment");
    expect(envReq?.body).toEqual({ variables: { XKIRO_API_KEY: "sk-ephemeral-123" } });
  });
});
