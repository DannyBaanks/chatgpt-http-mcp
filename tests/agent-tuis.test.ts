// tests/agent-tuis.test.ts — multiharness: lo que hacía solo agy (consola coordinada,
// identidad, ACK, tareas siguientes) para opencode, openisy, claude, codex, gemini...
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TUIS, agentArgv, findAgentBinary, resolveAgentTui } from "../src/agent-tuis";
import { buildAgentBootstrapProtocol } from "../src/agent-protocol";
import { buildTaskInjection, consoleWantsInjection, deliverTaskToConsole, pasteIntoTmux } from "../src/console-delivery";
import { createConsole, ensureConsoleSchema, getConsole } from "../src/console-registry";
import { openMonitorDatabase } from "../src/remote-monitor";

const P = { taskId: "task-x", operationId: "op-x", monitorUrl: "http://127.0.0.1:8799", isymcpCliPath: "/r/src/isymcp.ts" };

describe("catálogo de agentes", () => {
  it("AT-01: ids únicos, alias resuelven, agy por defecto", () => {
    const ids = AGENT_TUIS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["agy", "claude", "opencode", "openisy", "codex", "gemini", "copilot", "droid", "kimi", "crush", "hermes", "openclaw"]) {
      expect(resolveAgentTui(id)?.id).toBe(id);
    }
    expect(resolveAgentTui("antigravity")?.id).toBe("agy");
    expect(resolveAgentTui("open-isy")?.id).toBe("openisy");
    expect(resolveAgentTui(undefined)?.id).toBe("agy");
    expect(resolveAgentTui("nope")).toBeNull();
  });

  it("AT-02: argv del prompt inicial según el --help de cada TUI", () => {
    const argv = (id: string) => agentArgv(resolveAgentTui(id)!, `/bin/${id}`, "HAZ X", { mode: "plan" });
    expect(argv("agy")).toEqual(["/bin/agy", "-i", "HAZ X", "--mode", "plan"]);
    expect(argv("opencode")).toEqual(["/bin/opencode", "--prompt", "HAZ X"]);
    expect(argv("openisy")).toEqual(["/bin/openisy", "--prompt", "HAZ X"]);
    expect(argv("claude")).toEqual(["/bin/claude", "HAZ X"]);
    // Con la ruta del CLI: prompt primero y solo los comandos `monitor` de ISyMCP pre-aprobados.
    expect(agentArgv(resolveAgentTui("claude")!, "/bin/claude", "HAZ X", { cliPath: "/r/src/isymcp.ts" }))
      .toEqual(["/bin/claude", "HAZ X", "--allowedTools", 'Bash(bun run "/r/src/isymcp.ts" monitor:*)']);
    expect(argv("codex")).toEqual(["/bin/codex", "HAZ X"]);
    expect(argv("gemini")).toEqual(["/bin/gemini", "-i", "HAZ X"]);
    expect(argv("copilot")).toEqual(["/bin/copilot", "-i", "HAZ X"]);
    // Sin flag interactivo con prompt: se arranca vacía y el prompt se pega.
    expect(argv("kimi")).toEqual(["/bin/kimi"]);
    expect(argv("hermes")).toEqual(["/bin/hermes", "chat"]);
  });

  it("AT-03: listener por agente: agy su /task, el resto (claude incluido) por inyección", () => {
    expect(resolveAgentTui("agy")!.listener).toBe("agy-task");
    for (const id of ["claude", "opencode", "openisy", "codex", "gemini", "copilot", "droid", "kimi", "crush", "hermes", "openclaw"]) {
      expect(resolveAgentTui(id)!.listener).toBe("inject");
    }
  });
});

describe("protocolo de arranque por listener", () => {
  it("AT-04: agy conserva su protocolo; con consola el ACK ya no cierra la tarea", () => {
    const plain = buildAgentBootstrapProtocol(P);
    expect(plain).toContain("WaitMsBeforeAsync: 500");
    expect(plain).toContain("monitor wait-next 3600");
    expect(plain).toContain("monitor respond task-x");
    const withConsole = buildAgentBootstrapProtocol({ ...P, consoleId: "con-0000abcd" });
    expect(withConsole).toContain("monitor ack task-x --console con-0000abcd");
    expect(withConsole).not.toContain("--no-wait");
    // agy sigue despertando con tareas no dirigidas: su wait-next no filtra por consola.
    expect(withConsole).toContain("monitor wait-next 3600\n");
  });

  it("AT-05: inject no bloquea la consola con wait-next y anuncia cómo llegan las tareas", () => {
    const t = buildAgentBootstrapProtocol({ ...P, consoleId: "con-0000abcd", listener: "inject", agentLabel: "OpenISy" });
    expect(t).toContain("consola OpenISy");
    expect(t).toContain("NO ejecutes wait-next");
    expect(t).toContain("[ISyMCP] Nueva tarea");
    expect(t).toContain("monitor ack task-x --console con-0000abcd");
    expect(t).toContain("--complete");
    expect(t).not.toContain("WaitMsBeforeAsync");
  });

  it("AT-06: background-bash arma wait-next dirigido a su consola", () => {
    const t = buildAgentBootstrapProtocol({ ...P, consoleId: "con-0000abcd", listener: "background-bash", agentLabel: "Claude Code" });
    expect(t).toContain("run_in_background: true");
    expect(t).toContain("monitor wait-next 3600 --console con-0000abcd");
  });
});

describe("entrega por tmux", () => {
  it("AT-07: orden exacto de tmux: has-session, load-buffer por stdin, paste -p, Enter", () => {
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const r = pasteIntoTmux("sock", "sess", "linea1\nlinea2", (argv, stdin) => { calls.push({ argv, stdin }); return { code: 0, err: "" }; });
    expect(r.delivered).toBe(true);
    expect(calls.map((c) => c.argv.slice(3, 4)[0])).toEqual(["has-session", "load-buffer", "paste-buffer", "send-keys"]);
    expect(calls[1]!.stdin).toBe("linea1\nlinea2");
    expect(calls[2]!.argv).toContain("-p");
    expect(calls.every((c) => c.argv[0] === "tmux" && c.argv[1] === "-L" && c.argv[2] === "sock")).toBe(true);
  });

  it("AT-08: sesión inexistente no se inventa", () => {
    const r = pasteIntoTmux("sock", "sess", "x", () => ({ code: 1, err: "no server" }));
    expect(r).toEqual({ delivered: false, reason: "tmux_session_missing: sess" });
  });

  it("AT-09: solo se inyecta en consolas inject con tmux propio", () => {
    const base = { tmux_session: "s", tmux_socket: "k", state: "ACKED" as const };
    expect(consoleWantsInjection({ ...base, agent: "openisy" })).toBe(true);
    expect(consoleWantsInjection({ ...base, agent: "agy" })).toBe(false);
    expect(consoleWantsInjection({ ...base, agent: "claude" })).toBe(true);
    expect(consoleWantsInjection({ ...base, agent: "opencode", tmux_socket: null })).toBe(false);
    // Terminar la primera tarea no cierra la consola: puede recibir más (como agy).
    expect(consoleWantsInjection({ ...base, agent: "opencode", state: "COMPLETED" } as any)).toBe(true);
    const rec = { agent: "agy", tmux_session: "s", tmux_socket: "k", state: "ACKED" } as any;
    expect(deliverTaskToConsole(rec, { task_id: "t", kind: "k", description: "d" }, "/c").delivered).toBe(false);
  });

  it("AT-10: el texto inyectado trae la tarea completa y cómo responderla", () => {
    const text = buildTaskInjection({ task_id: "task-9", kind: "review", description: "Revisa PITON\ncon calma" }, "/r/src/isymcp.ts");
    expect(text).toStartWith("[ISyMCP] Nueva tarea");
    expect(text).toContain("Revisa PITON\ncon calma");
    expect(text).toContain('monitor respond task-9 --summary');
  });
});

describe("registro: migración aditiva", () => {
  it("AT-11: una base vieja sin columnas agent/tmux_socket se migra y las consolas viejas son agy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-mig-"));
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(join(dir, "m.sqlite"));
      db.exec(`CREATE TABLE console_sessions (console_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, operation_id TEXT NOT NULL, title TEXT NOT NULL,
        cwd TEXT NOT NULL, workspace_id TEXT NOT NULL, terminal TEXT NOT NULL DEFAULT '', tmux_session TEXT, agent_pid INTEGER, launcher_pid INTEGER,
        state TEXT NOT NULL, token_hash TEXT NOT NULL, token_fp TEXT NOT NULL, created_at INTEGER NOT NULL, ack_at INTEGER, ack_summary TEXT,
        ack_hmac TEXT, last_event_at INTEGER NOT NULL, events_count INTEGER NOT NULL DEFAULT 0, log_path TEXT NOT NULL)`);
      db.query(`INSERT INTO console_sessions VALUES ('con-11111111','t','o','old','/tmp','ws','',NULL,NULL,NULL,'ACKED','h','fp',1,NULL,NULL,NULL,1,0,'/dev/null')`).run();
      ensureConsoleSchema(db);
      const env = { ...process.env, CODEX_WEB_HTTP_HOME: dir };
      expect(getConsole(db, "con-11111111", env)!.agent).toBe("agy");
      const c = createConsole(db, { taskId: "t2", operationId: "o2", title: "n", cwd: "/tmp", workspaceId: "ws", agent: "openisy" }, env);
      expect(getConsole(db, c.console_id, env)!.agent).toBe("openisy");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// E2E real (sin ChatGPT): un "opencode" falso en tmux recibe la instrucción inicial,
// registra identidad/PID como agy, y una tarea posterior de monitor.submit llega pegada.
const hasTmux = Boolean(Bun.which("tmux")) && process.platform !== "win32";
describe.skipIf(!hasTmux)("E2E multiharness con tmux real", () => {
  let dir: string;
  const socket = `isymcp-test-${process.pid}`;
  const saved: Record<string, string | undefined> = {};
  let spawnAgentTui: typeof import("../src/tui-launcher").spawnAgentTui;
  let dispatch: typeof import("../src/mcp/gateway").dispatchIsyMcpAction;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agent-e2e-"));
    for (const k of ["PATH", "CODEX_WEB_HTTP_HOME", "CODEX_WEB_HTTP_MONITOR_DB", "ISYMCP_CONSOLE_TMUX_SOCKET", "DISPLAY", "WAYLAND_DISPLAY",
      "ISYMCP_ALLOW_AGENT_SPAWN", "CODEX_WEB_HTTP_TOKEN", "OPENAI_API_KEY"]) saved[k] = process.env[k];
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // Falso opencode: guarda su argv y entorno, y luego todo lo que se le escriba.
    writeFileSync(join(bin, "opencode"), `#!/bin/sh
printf '%s\\n' "$@" > '${dir}/argv.txt'
env > '${dir}/env.txt'
exec cat >> '${dir}/input.txt'
`);
    chmodSync(join(bin, "opencode"), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.CODEX_WEB_HTTP_HOME = join(dir, "home");
    process.env.CODEX_WEB_HTTP_MONITOR_DB = join(dir, "m.sqlite");
    process.env.ISYMCP_CONSOLE_TMUX_SOCKET = socket;
    delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
    // El operador habilitó consolas; y hay secretos en el entorno que NO deben llegar al agente.
    process.env.ISYMCP_ALLOW_AGENT_SPAWN = "1";
    process.env.CODEX_WEB_HTTP_TOKEN = "bridge-secret-should-not-leak";
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    ({ spawnAgentTui } = await import("../src/tui-launcher"));
    ({ dispatchIsyMcpAction: dispatch } = await import("../src/mcp/gateway"));
  });
  afterAll(() => {
    Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });

  const waitFor = async (cond: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (cond()) return true; await Bun.sleep(100); }
    return cond();
  };

  it("AT-12: spawn opencode -> consola registrada, prompt+protocolo por argv, tarea siguiente pegada en su terminal", async () => {
    expect(findAgentBinary(resolveAgentTui("opencode")!)).toBe(join(dir, "bin", "opencode"));
    const res = await spawnAgentTui({ agent: "opencode", prompt: "Revisa el repo PITON", terminalPreference: "tmux", cwd: dir });
    expect(res.ok).toBe(true);
    expect(res.agent).toBe("opencode");
    expect(res.listener).toBe("inject");
    expect(res.tmuxSocket).toBe(socket);
    expect(res.consoleId).toMatch(/^con-[a-f0-9]{8}$/);

    expect(await waitFor(() => existsSync(join(dir, "argv.txt")))).toBe(true);
    const argv = readFileSync(join(dir, "argv.txt"), "utf8");
    expect(argv.startsWith("--prompt\n")).toBe(true);
    expect(argv).toContain("Revisa el repo PITON");
    expect(argv).toContain(`CONSOLE_ID: ${res.consoleId}`);
    expect(argv).toContain("NO ejecutes wait-next");
    // Identidad exportada por el wrapper, igual que con agy (el token no viaja en argv).
    // El falso escribe argv.txt y DESPUÉS env.txt: se espera a que env.txt esté completo (carrera en CI lento).
    const envPath = join(dir, "env.txt");
    expect(await waitFor(() => existsSync(envPath) && readFileSync(envPath, "utf8").includes("ISYMCP_CONSOLE_ID="))).toBe(true);
    const envTxt = readFileSync(envPath, "utf8");
    expect(envTxt).toContain(`ISYMCP_CONSOLE_ID=${res.consoleId}`);
    expect(envTxt).toMatch(/ISYMCP_ACK_TOKEN=ctk_/);
    // Entorno limpio: ni el token del bridge ni API keys; sí las ubicaciones de ISyMCP.
    expect(envTxt).not.toContain("bridge-secret-should-not-leak");
    expect(envTxt).not.toContain("sk-should-not-leak");
    expect(envTxt).toContain(`CODEX_WEB_HTTP_HOME=${join(dir, "home")}`);
    expect(envTxt).toMatch(/^PATH=/m);
    expect(argv).not.toContain("ctk_");

    const db = openMonitorDatabase(join(dir, "m.sqlite"));
    const rec = getConsole(db, res.consoleId!, process.env)!;
    db.close();
    expect(rec.agent).toBe("opencode");
    expect(rec.tmux_socket).toBe(socket);
    expect(rec.tmux_session).toBe(res.tmuxSession!);
    expect(rec.agent_pid).toBeGreaterThan(0);

    const sub = await dispatch("monitor.submit", { console_id: res.consoleId, kind: "review_and_test", description: "Segunda tarea: corre los tests" });
    expect(sub.ok).toBe(true);
    expect((sub.result as any).delivery).toEqual({ delivered: true, reason: "pasted" });
    expect(await waitFor(() => existsSync(join(dir, "input.txt")) && readFileSync(join(dir, "input.txt"), "utf8").includes("corre los tests"))).toBe(true);
    const input = readFileSync(join(dir, "input.txt"), "utf8");
    expect(input).toContain("[ISyMCP] Nueva tarea");
    expect(input).toContain("monitor respond");

    // Con el permiso apagado, la tarea se encola pero NO se pega en la consola.
    delete process.env.ISYMCP_ALLOW_AGENT_SPAWN;
    const off = await dispatch("monitor.submit", { console_id: res.consoleId, description: "no debe llegar" });
    expect((off.result as any).delivery).toEqual({ delivered: false, reason: "agent_spawn_disabled" });
    const offSpawn = await dispatch("tui.spawn", { agent: "opencode", prompt: "x" });
    expect(offSpawn.ok).toBe(false);
    expect(offSpawn.error).toContain("isymcp allow agents on");
    process.env.ISYMCP_ALLOW_AGENT_SPAWN = "1";
    expect((await dispatch("tui.spawn", { agent: "agy", prompt: "x", dangerously_skip_permissions: true })).error).toContain("solo desde la CLI local");

    // Una tarea dirigida a una consola que no existe no se entrega.
    const ghost = await dispatch("monitor.submit", { console_id: "con-00000000", description: "x" });
    expect((ghost.result as any).delivery.delivered).toBe(false);
  });

  it("AT-13: errores claros: agente desconocido, no instalado y skip-permissions fuera de agy", async () => {
    expect((await spawnAgentTui({ agent: "nope", prompt: "x", dryRun: true })).error).toBe("unknown_agent");
    expect((await spawnAgentTui({ agent: "opencode", prompt: "x", dryRun: true, dangerouslySkipPermissions: true })).error).toBe("skip_permissions_agy_only");
    const dry = await spawnAgentTui({ agent: "opencode", prompt: "x", dryRun: true, terminalPreference: "tmux" });
    expect(dry.ok).toBe(true);
    expect(dry.state).toBe("PREPARED");
    expect(dry.command.slice(0, 4)).toEqual(["tmux", "-L", socket, "new-session"]);
  });

  it("AT-14: el gateway lista el catálogo con lo instalado", async () => {
    const r = await dispatch("tui.agents");
    expect(r.ok).toBe(true);
    const oc = (r.result as any[]).find((a) => a.agent === "opencode");
    expect(oc).toMatchObject({ installed: true, prompt_via: "argv", listener: "inject", skip_permissions: false });
  });
});
