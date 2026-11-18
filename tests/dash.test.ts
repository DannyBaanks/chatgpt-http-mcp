import { describe, expect, it } from "bun:test";
import { resolveConfirmation, keyToAction, allCommandActions } from "../src/dash/keys";
import { createInitialState, readDashSnapshot } from "../src/dash/app";
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
    const state = { ...createInitialState(Date.parse("2026-11-18T12:00:00.000Z")), ...snapshot };
    const frame = stripAnsiCodes(renderFrame(state, 140, 30));
    expect(frame).toContain("fixture-ready");
    expect(frame).toContain("ready");
    expect(frame).toContain("fixture-problem");
    expect(frame).toContain("failed");
    expect(frame).toContain("pid=202");
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

  it("exige y para d, s, a, x y R; cualquier otra tecla cancela", () => {
    for (const key of ["d", "s", "a", "x", "R"]) {
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

  it("se adapta a 80 y 140 columnas sin exceder el ancho ni la altura", () => {
    const state = { ...createInitialState(), status: statusFixture, hub: hubFixture };
    for (const width of [80, 140]) {
      const frame = renderFrame(state, width, 24);
      const lines = frame.split("\n");
      expect(lines.length).toBeLessThanOrEqual(24);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
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
