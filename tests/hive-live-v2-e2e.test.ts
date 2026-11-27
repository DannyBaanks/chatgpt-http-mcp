// tests/hive-live-v2.test.ts — Test E2E real Victus ↔ Xeon para Hive Live v2 sobre munder-link@1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import { join } from "node:path";
import {
  deliverLiveMessage,
  isPidAlive,
  listLiveRoster,
  readAgentInbox,
  registerLiveAgent,
  waitForAgentMessage,
} from "../src/hive/live";
import { HiveManager } from "../src/hive/manager";
import {
  remoteHiveDeliver,
  remoteHiveRoster,
  remoteHiveSpawn,
  trustPeer,
} from "../src/link/client";
import { createLinkServer } from "../src/link/server";
import { loadIdentity } from "../src/link/store";

let tmpRoot: string;
let victusDir: string;
let xeonDir: string;
let victusHive: HiveManager;
let xeonHive: HiveManager;
let xeonServer: http.Server;
let xeonPort: number;
let spawnedCalls: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(os.tmpdir(), "isymcp-hive-live-v2-"));
  victusDir = join(tmpRoot, "victus-link");
  xeonDir = join(tmpRoot, "xeon-link");
  victusHive = new HiveManager({ hiveRoot: join(tmpRoot, "victus-hive") });
  xeonHive = new HiveManager({ hiveRoot: join(tmpRoot, "xeon-hive") });
  victusHive.ensureHive();
  xeonHive.ensureHive();

  const victusId = loadIdentity(victusDir);
  const { server, identity: xeonId } = createLinkServer({
    dir: xeonDir,
    hive: xeonHive,
    hiveSpawnHandler: async (args, peer, hive) => {
      spawnedCalls.push({ args, from: peer.office_id });
      const agent = registerLiveAgent(hive, {
        agent_id: String(args.name || "spawned-agent"),
        harness: String(args.harness || "claude"),
        role: typeof args.role === "string" ? args.role : undefined,
        pid: process.pid,
        cwd: typeof args.cwd === "string" ? args.cwd : tmpRoot,
      });
      return { spawned: true, agent };
    },
  });

  xeonServer = server;
  await new Promise<void>((resolve) => {
    xeonServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = xeonServer.address();
  xeonPort = typeof addr === "object" && addr ? addr.port : 0;

  // Emparejar Victus <-> Xeon (solo autoridad office: true, compute: false)
  trustPeer(
    {
      office_id: xeonId.office_id,
      name: "xeon-test",
      sign_pub: xeonId.sign.x,
      box_pub: xeonId.box.x,
      addresses: [`127.0.0.1:${xeonPort}`],
      authority: { office: true, compute: false },
    },
    victusDir,
  );
  trustPeer(
    {
      office_id: victusId.office_id,
      name: "victus-test",
      sign_pub: victusId.sign.x,
      box_pub: victusId.box.x,
      addresses: ["127.0.0.1:1"],
      authority: { office: true, compute: false },
    },
    xeonDir,
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => xeonServer.close(() => resolve()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("Hive Live v2 — PID liveness, cross-machine roster, wake & spawn", () => {
  test("isPidAlive distingue PID vivo, PID inexistente y PID inválido", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
    expect(isPidAlive(999_999_999)).toBe(false);
  });

  test("registerLiveAgent + remoteHiveRoster expone agentes con liveness real sobre munder-link@1", async () => {
    registerLiveAgent(xeonHive, {
      agent_id: "win-live",
      name: "Windows Agent",
      harness: "claude",
      pid: process.pid,
      cwd: tmpRoot,
      capabilities: ["win-native", "cuda"],
    });
    registerLiveAgent(xeonHive, {
      agent_id: "win-dead",
      name: "Stale Agent",
      harness: "codex",
      pid: 999_999_999,
      cwd: tmpRoot,
    });

    const local = listLiveRoster(xeonHive);
    expect(local.find((a) => a.agent_id === "win-live")?.alive).toBe(true);
    expect(local.find((a) => a.agent_id === "win-dead")?.alive).toBe(false);

    const remote = await remoteHiveRoster("xeon-test", { dir: victusDir });
    expect(remote.result.hive_enabled).toBe(true);
    const live = remote.result.agents.find((a) => a.agent_id === "win-live");
    const dead = remote.result.agents.find((a) => a.agent_id === "win-dead");
    expect(live?.alive).toBe(true);
    expect(live?.pid).toBe(process.pid);
    expect(dead?.alive).toBe(false);
  });

  test("remoteHiveDeliver despierta waitForAgentMessage en curso sin race condition", async () => {
    registerLiveAgent(xeonHive, {
      agent_id: "win-sleeper",
      harness: "claude",
      pid: process.pid,
      cwd: tmpRoot,
    });

    const waitPromise = waitForAgentMessage(xeonHive, "win-sleeper", { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 30));

    const delivered = await remoteHiveDeliver(
      "xeon-test",
      {
        to: "win-sleeper",
        from: "agy-victus",
        subject: "Despierta por cable 1 Gbps",
        body: "Ya terminamos el enlace directo",
        act: "inform",
      },
      { dir: victusDir },
    );
    expect(delivered.result.delivered).toBe(true);

    const woken = await waitPromise;
    expect(woken.woken).toBe(true);
    expect(woken.messages.length).toBe(1);
    expect(woken.messages[0]!.from).toBe("agy-victus@victus-test");
    expect(woken.messages[0]!.subject).toBe("Despierta por cable 1 Gbps");
    expect(woken.elapsed_ms).toBeLessThan(2000);

    // Ya marcado como leído
    expect(readAgentInbox(xeonHive, "win-sleeper", false).length).toBe(0);
  });

  test("waitForAgentMessage devuelve de inmediato si ya había mensaje antes de llamar wait", async () => {
    registerLiveAgent(victusHive, {
      agent_id: "agy-early",
      harness: "agy",
      pid: process.pid,
      cwd: tmpRoot,
    });
    deliverLiveMessage(
      victusHive,
      { to: "agy-early", subject: "Llegó antes", body: "sin race" },
      "win-live@xeon-test",
    );
    const res = await waitForAgentMessage(victusHive, "agy-early", { timeoutMs: 2000 });
    expect(res.woken).toBe(true);
    expect(res.messages[0]!.subject).toBe("Llegó antes");
    expect(res.elapsed_ms).toBeLessThan(500);
  });

  test("remoteHiveSpawn invoca hiveSpawnHandler y devuelve agente registrado", async () => {
    spawnedCalls = [];
    const res = await remoteHiveSpawn(
      "xeon-test",
      {
        harness: "claude",
        name: "win-worker-2",
        role: "Pre-CI runner",
        prompt: "Corre tests nativos",
        parent_agent_id: "agy-victus",
      },
      { dir: victusDir },
    );
    expect(res.result.spawned).toBe(true);
    expect(spawnedCalls.length).toBe(1);
    const roster = listLiveRoster(xeonHive);
    expect(roster.some((a) => a.agent_id === "win-worker-2" && a.alive)).toBe(true);
  });
});
