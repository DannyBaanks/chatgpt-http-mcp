// tests/sandbox-cli.test.ts — Pruebas del comando `isymcp sandbox exec|stop|status`, estabilidad del CLI (--help sin efectos secundarios) y UI.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxAgentPrompt, parseFlexDuration, runSandboxWizard } from "../src/cli/commands/sandbox";
import { clipMenuLine } from "../src/menu";
import { createInitialState } from "../src/dash/app";
import { renderFrame, stripAnsiCodes, visibleWidth } from "../src/dash/render";

const CLI = join(import.meta.dir, "..", "src", "isymcp.ts");

function runCli(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, "run", CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    out: `${r.stdout.toString()}${r.stderr.toString()}`,
  };
}

describe("isymcp sandbox CLI", () => {
  it("SB-01: buildSandboxAgentPrompt incluye token, COMANDO y herramientas detectadas", () => {
    const prompt = buildSandboxAgentPrompt({
      cwd: "/tmp/ws",
      token: "tok_demo_123456",
      writable: true,
      shellEnabled: true,
      tools: { isymem: true, rtk: true, ziggrep: true },
    });
    expect(prompt).toContain("COMANDO: @CODEX ISYMCP");
    expect(prompt).toContain("turn_token: tok_demo_123456");
    expect(prompt).toContain("Primero llama codex_turn_start y lee bootstrap.content.");
    expect(prompt).toContain("isymem projects");
    expect(prompt).toContain("rtk gain");
    expect(prompt).toContain("ziggrep");
    expect(prompt).toContain("bwrap-workspace-write");
  });

  it("SB-02: sandbox exec --no-up --json crea sesión rw + enciende shell_exec y sandbox stop lo limpia todo", () => {
    const home = mkdtempSync(join(tmpdir(), "isymcp-sb-home-"));
    const ws = mkdtempSync(join(tmpdir(), "isymcp-sb-ws-"));
    try {
      const execRes = runCli(
        ["sandbox", "exec", "--no-up", "--cwd", ws, "--for", "2h", "--json"],
        { CODEX_WEB_HTTP_HOME: home },
      );
      expect(execRes.code).toBe(0);
      const data = JSON.parse(execRes.stdout);
      expect(data.ok).toBe(true);
      expect(data.session.cwd).toBe(ws);
      expect(data.session.writable).toBe(true);
      expect(typeof data.session.token).toBe("string");
      expect(data.session.token.length).toBeGreaterThan(20);
      expect(data.shell.enabled).toBe(true);
      expect(data.prompt).toContain(`turn_token: ${data.session.token}`);
      expect(data.prompt).toContain("COMANDO: @CODEX ISYMCP");

      const statusRes = runCli(["sandbox", "status", "--json"], { CODEX_WEB_HTTP_HOME: home });
      expect(statusRes.code).toBe(0);
      const st = JSON.parse(statusRes.stdout);
      expect(st.shell.on).toBe(true);
      expect(st.active_sessions.some((s: { fp: string }) => s.fp === data.session.fp)).toBe(true);

      const stopRes = runCli(["sandbox", "stop"], { CODEX_WEB_HTTP_HOME: home });
      expect(stopRes.code).toBe(0);
      expect(stopRes.out).toContain("shell_exec apagado");

      const afterStop = JSON.parse(runCli(["sandbox", "status", "--json"], { CODEX_WEB_HTTP_HOME: home }).stdout);
      expect(afterStop.shell.on).toBe(false);
      expect(afterStop.active_sessions.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("SB-03: sandbox exec --no-up --prompt-only --ro --no-shell imprime solo el prompt en stdout y no abre shell", () => {
    const home = mkdtempSync(join(tmpdir(), "isymcp-sb-po-"));
    const ws = mkdtempSync(join(tmpdir(), "isymcp-sb-pows-"));
    try {
      const res = runCli(
        ["sandbox", "exec", "--no-up", "--cwd", ws, "--ro", "--no-shell", "--prompt-only", "--task", "Revisa el README"],
        { CODEX_WEB_HTTP_HOME: home },
      );
      expect(res.code).toBe(0);
      expect(res.stdout.startsWith("Trabaja como un agente local en")).toBe(true);
      expect(res.stdout).toContain("bwrap-read-only");
      expect(res.stdout).toContain("Tarea: Revisa el README");
      expect(res.stdout).toContain("COMANDO: @CODEX ISYMCP");
      expect(res.stdout).not.toContain("COPIA Y PEGA");

      const st = JSON.parse(runCli(["sandbox", "status", "--json"], { CODEX_WEB_HTTP_HOME: home }).stdout);
      expect(st.shell.on).toBe(false);
      expect(st.active_sessions[0].writable).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("SB-04: rechaza --for > 24h y --cwd inexistente con código 2", () => {
    const home = mkdtempSync(join(tmpdir(), "isymcp-sb-err-"));
    try {
      const badFor = runCli(["sandbox", "exec", "--no-up", "--for", "48h"], { CODEX_WEB_HTTP_HOME: home });
      expect(badFor.code).toBe(2);
      expect(badFor.out).toContain("máximo 24h");

      const badCwd = runCli(["sandbox", "exec", "--no-up", "--cwd", "/no/existe/este/dir/xyz"], { CODEX_WEB_HTTP_HOME: home });
      expect(badCwd.code).toBe(2);
      expect(badCwd.out).toContain("--cwd no existe");

      const badUses = runCli(["shell", "exec", "--no-up", "--shell-uses", "99"], { CODEX_WEB_HTTP_HOME: home });
      expect(badUses.code).toBe(2);
      expect(badUses.out).toContain("--shell-uses");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("SB-05: alias `isymcp shell exec --shell-uses 3` crea permiso acotado (allow once) sin abrir shell total", () => {
    const home = mkdtempSync(join(tmpdir(), "isymcp-sb-once-"));
    const ws = mkdtempSync(join(tmpdir(), "isymcp-sb-oncews-"));
    try {
      const res = runCli(
        ["shell", "exec", "--no-up", "--cwd", ws, "--for", "3", "--shell-uses", "3", "--json"],
        { CODEX_WEB_HTTP_HOME: home },
      );
      expect(res.code).toBe(0);
      const data = JSON.parse(res.stdout);
      expect(data.shell.mode).toBe("once");
      expect(data.shell.uses).toBe(3);
      expect(data.prompt).toContain("acotado a 3 uso(s)");

      const st = JSON.parse(runCli(["shell", "status", "--json"], { CODEX_WEB_HTTP_HOME: home }).stdout);
      expect(st.shell.on).toBe(false);
      expect(st.shell.once_uses).toBe(3);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("SB-06: runSandboxWizard guía paso a paso (shell acotado + horas escritas + cancelación)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "isymcp-sb-wiz-"));
    try {
      expect(parseFlexDuration("6")).toBe(6 * 3600_000);
      expect(parseFlexDuration("30m")).toBe(30 * 60_000);

      // Flujo completo: Enter cwd, rw (0), shell acotado (1) con 4 usos, duración custom (6) -> "5", todas tools (0), tarea, confirmar ""
      const answers = ["", "4", "5", "Auditar FLOW", ""];
      const picks = [0, 1, 6, 0];
      const cfg = await runSandboxWizard(
        { cwd: ws, tools: { isymem: true, rtk: true, ziggrep: true } },
        {
          ask: async () => answers.shift() ?? "",
          select: async () => picks.shift() ?? 0,
          log: () => undefined,
        },
      );
      expect(cfg).not.toBeNull();
      expect(cfg!.cwd).toBe(ws);
      expect(cfg!.writable).toBe(true);
      expect(cfg!.shellMode).toBe("once");
      expect(cfg!.shellUses).toBe(4);
      expect(cfg!.ttlMs).toBe(5 * 3600_000);
      expect(cfg!.task).toBe("Auditar FLOW");

      // Cancelar con Esc (-1) en paso 2 devuelve null sin lanzar.
      const cancelled = await runSandboxWizard(
        { cwd: ws, tools: { isymem: true, rtk: true, ziggrep: true } },
        {
          ask: async () => "",
          select: async () => -1,
          log: () => undefined,
        },
      );
      expect(cancelled).toBeNull();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("Estabilidad CLI: --help sin efectos secundarios ni stack traces", () => {
  const HELP_COMMANDS: string[][] = [
    ["sandbox", "--help"],
    ["shell", "--help"],
    ["up", "--help"],
    ["down", "--help"],
    ["status", "--help"],
    ["server", "--help"],
    ["tunnel", "--help"],
    ["allow", "--help"],
    ["taint", "--help"],
    ["session", "--help"],
    ["monitor", "--help"],
    ["phone", "--help"],
    ["canary", "--help"],
    ["harness", "--help"],
    ["panel", "--help"],
    ["tablero", "--help"],
    ["media", "--help"],
    ["comfy", "--help"],
    ["logs", "--help"],
    ["ask", "--help"],
    ["models", "--help"],
    ["command", "--help"],
    ["conversation"],
    ["conversation", "--help"],
    ["hub", "--help"],
    ["tui", "--help"],
    ["openswift", "--help"],
    ["dash", "--help"],
  ];

  it("todos los comandos responden --help con exit 0, sin stack trace y sin mutar estado", () => {
    const home = mkdtempSync(join(tmpdir(), "isymcp-help-clean-"));
    try {
      for (const args of HELP_COMMANDS) {
        const r = runCli(args, { CODEX_WEB_HTTP_HOME: home });
        expect({ args, code: r.code }).toEqual({ args, code: 0 });
        expect(r.out).not.toMatch(/\bat\s+.*\.ts:\d+:\d+/);
      }
      // `isymcp session --help` nunca debe crear sesiones de cookies falsas
      expect(existsSync(join(home, "sessions", "--help.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 25_000);
});

describe("Estabilidad UI (menu y dash)", () => {
  it("clipMenuLine recorta correctamente texto con ANSI y emojis sin exceder maxCols", () => {
    const raw = "\x1b[36m❯ \x1b[7m🐙 GitHub Extension…\x1b[0m  tokens, API y GitHub Actions muy largo";
    const clipped = clipMenuLine(raw, 24);
    expect(visibleWidth(clipped)).toBeLessThanOrEqual(24);
    expect(clipped.endsWith("\x1b[0m")).toBe(true);
  });

  it("dash renderFrame rellena líneas espaciadoras y soporta terminales diminutas", () => {
    const state = createInitialState(Date.now());
    state.loaded = true;
    state.status = {
      version: "isymcp-status/1",
      ts: new Date().toISOString(),
      server: { up: true, url: "http://127.0.0.1:8791", pid: 123, log: "/tmp/s.log" },
      tunnel: { ready: true, running: true, state: "ready" },
      mcp: { up: true },
      connector: "Codex ISyMCP",
      conversation: null,
      sessions: [
        { label: "expirada", fp: "aaaaaaaaaaaa", writable: false, expired: true },
        { label: "vigente", fp: "bbbbbbbbbbbb", writable: true, expired: false },
      ],
      panel: { up: false, url: "http://127.0.0.1:8798" },
      monitor: { up: false, url: "http://127.0.0.1:8799", pid: null },
      chatgpt: null,
      canary: null,
      tasks: null,
      gates: { shell: { on: false, expires: null }, agents: { on: false, expires: null } },
      taint: { tainted: false, until: null },
    };

    const frame = renderFrame(state, 120, 24);
    const lines = frame.split("\n");
    expect(lines.length).toBe(24);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(120);
    }
    expect(stripAnsiCodes(frame)).toContain("1 vivas · 1 caducadas");

    // Terminal diminuta en vista logs tampoco rompe ni excede límites.
    state.showLog = true;
    state.logLines = ["linea 1", "linea 2"];
    const tiny = renderFrame(state, 30, 5);
    expect(tiny.split("\n").length).toBeLessThanOrEqual(5);
    for (const line of tiny.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
  });
});
