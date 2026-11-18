import { describe, expect, it } from "bun:test";
import { resolveConfirmation, keyToAction, allCommandActions } from "../src/dash/keys";
import { createInitialState, dashController, readDashSnapshot, splitInputKeys } from "../src/dash/app";
import { computeAlerts, paletteAction, prettyHubLog, viewKeyAction } from "../src/dash/ops";
import { VIEWS } from "../src/dash/types";
import { renderFrame, stripAnsiCodes, visibleWidth } from "../src/dash/render";
import type { DashProvider, HubJson, StatusJson } from "../src/dash/types";

const statusFixture: StatusJson = {
  version: "isymcp-status/1",
  ts: "2026-11-18T12:00:00.000Z",
  server: { up: true, url: "http://127.0.0.1:8791", pid: 101, log: "/tmp/server.log" },
  tunnel: { ready: true, running: true, state: "connected" },
  mcp: { up: true },
  connector: "fixture",
  conversation: null,
  sessions: [
    { label: "live", fp: "fp-live", writable: false, expired: false },
    { label: "expired", fp: "fp-old", writable: false, expired: true },
  ],
  panel: { up: true, url: "http://127.0.0.1:8798" },
  monitor: { up: false, url: "http://127.0.0.1:8799", pid: null },
  chatgpt: null,
  canary: { ok: false, ts: "2026-11-18T11:59:00.000Z" },
  tasks: { total: 9, blocked: 2 },
  gates: {
    shell: { on: true, expires: "2026-11-18T13:00:00.000Z" },
    agents: { on: false, expires: null },
  },
  taint: { tainted: true, until: "2026-11-18T14:00:00.000Z" },
};

const hubFixture: HubJson = {
  servers: [
    {
      server: "fixture-ready",
      isolation: "shared",
      enabled: true,
      state: "ready",
      tools: 4,
      instances: [{ id: "one", pid: 202, state: "ready", in_flight: 0, ready_ms: 20 }],
    },
    {
      server: "fixture-problem",
      isolation: "per-client",
      enabled: true,
      state: "failed",
      tools: 1,
      instances: [{ id: "two", pid: 303, state: "failed", in_flight: 1, ready_ms: 0 }],
    },
  ],
};

const monitorAwaiting = {
  task_id: "task-await-1", state: "AWAITING_APPROVAL", workspace_id: "ws", kind: "tests", description: "correr tests",
  requested_actions: ["tests:run"], updated_at: Date.parse("2026-11-18T11:00:00.000Z"),
};

function fixtureProvider(options: { status?: StatusJson | null; hub?: HubJson | null } = {}): DashProvider {
  return {
    async status() { return options.status === undefined ? statusFixture : options.status; },
    async hub() { return options.hub === undefined ? hubFixture : options.hub; },
    async run() { throw new Error("el fixture de render no debe ejecutar comandos"); },
  };
}

describe("dashboard ISyMCP", () => {
  it("renderiza los MCP del fixture y sus estados", async () => {
    const provider = fixtureProvider();
    const snapshot = await readDashSnapshot(provider);
    const state = { ...createInitialState(Date.parse("2026-11-18T12:00:00.000Z")), ...snapshot, view: "hub" as const };
    const frame = stripAnsiCodes(renderFrame(state, 140, 30));
    expect(frame).toContain("fixture-ready");
    expect(frame).toContain("ready");
    expect(frame).toContain("fixture-problem");
    expect(frame).toContain("failed");
    expect(frame).toMatch(/fixture-ready.*202/);
  });

  it("marca permisos ON en rojo", () => {
    const state = { ...createInitialState(), status: statusFixture, hub: hubFixture };
    const frame = renderFrame(state, 140, 30);
    expect(frame).toContain("\x1b[31mshell: ON");
    expect(stripAnsiCodes(frame)).toContain("agents: off");
  });

  it("muestra hub caído cuando el proveedor no tiene respuesta", async () => {
    const snapshot = await readDashSnapshot(fixtureProvider({ hub: null }));
    const frame = stripAnsiCodes(renderFrame({ ...createInitialState(), ...snapshot }, 80, 24));
    expect(frame).toContain("hub caído");
  });

  it("exige y para d, r, s, a, x y R; cualquier otra tecla cancela", () => {
    for (const key of ["d", "r", "s", "a", "x", "R"]) {
      const action = keyToAction(key);
      expect(action?.kind).toBe("command");
      if (action?.kind === "command") {
        expect(action.confirm).toBeTruthy();
        expect(resolveConfirmation(action, "y")).toBe(action);
        expect(resolveConfirmation(action, "n")).toBeNull();
      }
    }
  });

  it("no ofrece permisos allow ... on", () => {
    const commands = allCommandActions().map((action) => action.args.join(" "));
    expect(commands).not.toContain("allow shell on");
    expect(commands).not.toContain("allow agents on");
    expect(commands).toContain("allow once shell");
    expect(commands).toContain("allow once agents");
  });

  it("todas las vistas se adaptan a 80 y 140 columnas sin exceder el ancho ni la altura", () => {
    for (const view of VIEWS) {
      for (const expanded of [false, true]) {
        const state = {
          ...createInitialState(), status: statusFixture, hub: hubFixture, loaded: true, view, expanded,
          monitorTasks: [monitorAwaiting], logLines: ['{"ts":"2026-11-18T12:00:00Z","event":"backend_ready","server":"x"}'],
          outputs: [{ ts: 0, cmd: "isymcp up", code: 0, ms: 10, lines: ["a".repeat(300)] }],
        };
        for (const width of [80, 140]) {
          const frame = renderFrame(state, width, 24);
          const lines = frame.split("\n");
          expect(lines.length).toBeLessThanOrEqual(24);
          for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});

describe("dash: estado de carga y permisos apagados", () => {
  it("antes de la primera lectura pinta 'cargando…', no 'hub caído'", () => {
    const frame = stripAnsiCodes(renderFrame(createInitialState(Date.parse(statusFixture.ts)), 120, 30));
    expect(frame).toContain("cargando…");
    expect(frame).not.toContain("hub caído");
  });

  it("un permiso apagado no deja separador colgando", () => {
    const state = { ...createInitialState(Date.parse(statusFixture.ts)), status: statusFixture, hub: { servers: [] }, loaded: true };
    const frame = stripAnsiCodes(renderFrame(state, 120, 30));
    expect(frame).toContain("agents: off");
    expect(frame).not.toMatch(/agents: off ·/);
  });
});

describe("centro de operaciones", () => {
  const now = Date.parse(statusFixture.ts);
  const base = () => ({ ...createInitialState(now), status: statusFixture, hub: hubFixture, loaded: true });

  it("traduce flechas, PgUp/PgDn, Shift+Tab, Tab y Escape suelto", () => {
    const keys: string[] = [];
    const feed = splitInputKeys((k) => keys.push(k));
    feed("\x1b[A"); feed("\x1b[B"); feed("\x1b[5~"); feed("\x1b[6~"); feed("\x1b[Z"); feed("\t"); feed("\x1b"); feed("\x1bOA");
    expect(keys).toEqual(["up", "down", "pageup", "pagedown", "backtab", "tab", "escape", "up"]);
  });

  it("cada alerta trae su arreglo: MCP caído → reiniciar SOLO ese MCP, con confirmación", () => {
    const alerts = computeAlerts(statusFixture, hubFixture, now, [monitorAwaiting]);
    const mcp = alerts.find((a) => a.text.includes("fixture-problem"));
    expect(mcp?.level).toBe("crit");
    expect(mcp?.fix.kind).toBe("command");
    if (mcp?.fix.kind === "command") {
      expect(mcp.fix.args).toEqual(["hub", "restart", "fixture-problem"]);
      expect(mcp.fix.confirm).toBeTruthy();
    }
    expect(alerts.some((a) => a.text.includes("esperan tu aprobación"))).toBe(true);
    expect(alerts[0]!.level).toBe("crit");
  });

  it("canario OK pero de hace más de 26 h es un aviso", () => {
    const old = { ...statusFixture, canary: { ok: true, ts: "2026-11-12T08:00:00.000Z" } };
    const alerts = computeAlerts(old, { servers: [] }, now);
    expect(alerts.find((a) => a.text.startsWith("canario viejo"))?.level).toBe("warn");
  });

  it("K reinicia el MCP seleccionado; un MCP direct no se toca", () => {
    const state = { ...base(), view: "hub" as const, cursor: { ...createInitialState().cursor, hub: 1 } };
    const action = viewKeyAction("K", state);
    expect(action?.kind === "command" && action.args).toEqual(["hub", "restart", "fixture-problem"]);
    const direct = { ...state, hub: { servers: [{ ...hubFixture.servers[0]!, state: "direct", instances: [] }] }, cursor: createInitialState().cursor };
    expect(viewKeyAction("K", direct)?.kind).toBe("note");
  });

  it("sesiones: X revoca por fp, C revoca todas las caducadas en lote; ambas confirman", () => {
    const state = { ...base(), view: "sesiones" as const };
    const x = viewKeyAction("X", state);
    expect(x?.kind === "command" && x.args).toEqual(["session", "revoke", "fp-live"]);
    expect(x?.kind === "command" && x.confirm).toBeTruthy();
    const c = viewKeyAction("C", state);
    expect(c?.kind === "batch" && c.steps).toEqual([["session", "revoke", "fp-old"]]);
  });

  it("Y solo aprueba tareas del monitor en AWAITING_APPROVAL", () => {
    const rows = { ...base(), view: "tareas" as const, status: { ...statusFixture, tasks: { total: 0, blocked: 0, items: [] } } };
    const awaiting = viewKeyAction("Y", { ...rows, monitorTasks: [monitorAwaiting] });
    expect(awaiting?.kind === "command" && awaiting.args).toEqual(["monitor", "approve", "task-await-1"]);
    expect(viewKeyAction("Y", { ...rows, monitorTasks: [{ ...monitorAwaiting, state: "RUNNING" }] })?.kind).toBe("note");
  });

  it("paleta: bloquea lo interactivo, confirma lo destructivo y quita el prefijo isymcp", () => {
    expect(paletteAction("dash").kind).toBe("note");
    expect(paletteAction("monitor run").kind).toBe("note");
    const reload = paletteAction("isymcp hub reload");
    expect(reload.kind === "command" && reload.args).toEqual(["hub", "reload"]);
    expect(reload.kind === "command" && reload.confirm).toBeTruthy();
    const plain = paletteAction("hub status");
    expect(plain.kind === "command" && plain.confirm).toBeFalsy();
    expect(paletteAction("allow shell off").kind === "command" && (paletteAction("allow shell off") as { confirm?: string }).confirm).toBeFalsy();
    expect((paletteAction("allow shell on") as { confirm?: string }).confirm).toBeTruthy();
  });

  it("el log del hub oculta las conexiones de sondeo solo si se pide", () => {
    const raw = [
      '{"ts":"2026-11-18T12:00:00Z","event":"client_connected","client":"conn-1","info":"isymcp-hub-status 0"}',
      '{"ts":"2026-11-18T12:00:00Z","event":"client_disconnected","client":"conn-1"}',
      '{"ts":"2026-11-18T12:00:01Z","event":"backend_exit","server":"rea","error":"x"}',
    ];
    expect(prettyHubLog(raw, true)).toHaveLength(1);
    expect(prettyHubLog(raw, true)[0]).toContain("backend_exit server=rea");
    expect(prettyHubLog(raw, false)).toHaveLength(3);
  });

  it("de punta a punta: 2 → j → K → y ejecuta hub restart del MCP elegido y guarda la salida", async () => {
    const calls: string[][] = [];
    const provider: DashProvider = {
      ...fixtureProvider(),
      async run(args) { calls.push(args); return { code: 0, out: "  ↻ fixture-problem#1 pid=303: SIGTERM\n" }; },
    };
    const state = base();
    const ctl = dashController(state, provider);
    for (const k of ["2", "j", "K"]) ctl.key(k);
    expect(calls).toHaveLength(0);
    expect(state.message).toContain("Reiniciar solo fixture-problem");
    ctl.key("y");
    await ctl.settled();
    expect(calls).toEqual([["hub", "restart", "fixture-problem"]]);
    expect(state.outputs.at(-1)?.cmd).toBe("isymcp hub restart fixture-problem");
    expect(state.message).toContain("OK");
  });

  it("cualquier tecla distinta de y cancela, y la paleta corre el comando escrito", async () => {
    const calls: string[][] = [];
    const provider: DashProvider = { ...fixtureProvider(), async run(args) { calls.push(args); return { code: 0, out: "ok" }; } };
    const state = base();
    const ctl = dashController(state, provider);
    ctl.key("d"); ctl.key("n");
    expect(state.message).toContain("cancelado");
    for (const k of [":", ..."hub status", "enter"]) ctl.key(k);
    await ctl.settled();
    expect(calls).toEqual([["hub", "status"]]);
    expect(state.view).toBe("salida");
  });
});
