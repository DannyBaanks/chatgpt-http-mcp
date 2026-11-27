import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveManager, isPidAlive } from "../src/hive/manager";

const tempDirs: string[] = [];

function makeHive(): HiveManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isymcp-hive-live-v2-"));
  tempDirs.push(dir);
  return new HiveManager({ hiveRoot: dir });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("Hive Live v2 (PID liveness, readInbox, waitForMessages, spawnAgent)", () => {
  test("registerLive + liveRoster verifican liveness real por PID", () => {
    const hive = makeHive();
    const aliveEntry = hive.registerLive({
      id: "agent-alive",
      name: "Alive Agent",
      harness: "agy",
      pid: process.pid,
      wake: "wait",
    });
    expect(aliveEntry.alive).toBe(true);
    expect(isPidAlive(process.pid)).toBe(true);

    const deadEntry = hive.registerLive({
      id: "agent-dead",
      name: "Dead Agent",
      harness: "claude",
      pid: 99999999,
      wake: "hook",
    });
    expect(deadEntry.alive).toBe(false);

    const roster = hive.liveRoster();
    expect(roster.find((a) => a.id === "agent-alive")?.alive).toBe(true);
    expect(roster.find((a) => a.id === "agent-dead")?.alive).toBe(false);
  });

  test("readInbox(markRead) mueve a .done y waitForMessages despierta reactivamente", async () => {
    const hive = makeHive();
    hive.registerLive({ id: "sender", name: "Sender", pid: process.pid });
    hive.registerLive({ id: "receiver", name: "Receiver", pid: process.pid });

    // 1. Mensaje ya en inbox antes de waitForMessages
    hive.send({ to: "receiver", subject: "hola-1", body: "primero" }, "sender");
    expect(hive.readInbox("receiver", false)).toHaveLength(1);

    const immediate = await hive.waitForMessages("receiver", 1000, true);
    expect(immediate.timed_out).toBe(false);
    expect(immediate.messages).toHaveLength(1);
    expect(immediate.messages[0]!.subject).toBe("hola-1");
    expect(hive.readInbox("receiver", false)).toHaveLength(0);

    // 2. Mensaje que llega asíncronamente mientras waitForMessages espera
    setTimeout(() => {
      hive.send({ to: "receiver", subject: "hola-2", body: "despierta" }, "sender");
    }, 50);
    const asyncRes = await hive.waitForMessages("receiver", 2000, true);
    expect(asyncRes.timed_out).toBe(false);
    expect(asyncRes.messages).toHaveLength(1);
    expect(asyncRes.messages[0]!.subject).toBe("hola-2");

    // 3. Timeout limpio cuando no hay mensajes
    const timedOut = await hive.waitForMessages("receiver", 120, true);
    expect(timedOut.timed_out).toBe(true);
    expect(timedOut.messages).toHaveLength(0);
  });

  test("spawnAgent inyecta HIVE_AGENT_ID y registra PID vivo", async () => {
    const hive = makeHive();
    const outFile = path.join(hive.root()!, "spawned-env.txt");
    const script = [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(outFile)}, process.env.HIVE_AGENT_ID + "|" + process.env.ISYMCP_HIVE_ROOT);`,
      "setTimeout(() => {}, 500);",
    ].join(" ");

    const spawned = hive.spawnAgent({
      agent_id: "worker-test-1",
      harness: "custom",
      name: "Worker Test",
      prompt: "noop",
      command: [process.execPath, "-e", script],
    });

    expect(spawned.agent_id).toBe("worker-test-1");
    expect(spawned.pid).toBeGreaterThan(0);

    const deadline = Date.now() + 3000;
    while (!fs.existsSync(outFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.readFileSync(outFile, "utf8")).toBe(`worker-test-1|${hive.root()}`);

    try {
      process.kill(spawned.pid);
    } catch {
      /* already exited */
    }
  });
});
