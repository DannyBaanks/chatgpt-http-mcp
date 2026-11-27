import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveManager } from "../src/hive/manager";
import { deliverLiveMessage, readAgentInbox } from "../src/hive/live";
import { buildRelayPrompt, relayMessage, runRelay, wantsReply, type RelayOutcome } from "../src/hive/relay";
import type { HiveMessage } from "../src/hive/types";

const tempDirs: string[] = [];

function makeHive(): HiveManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isymcp-hive-relay-"));
  tempDirs.push(dir);
  const hive = new HiveManager({ hiveRoot: dir });
  hive.ensureHive();
  return hive;
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function msg(over: Partial<HiveMessage> = {}): HiveMessage {
  return {
    id: "m1",
    conversation: "c1",
    in_reply_to: null,
    from: "agy-victus@isymcp-dannyisyco",
    to: "win-agent",
    act: "request",
    subject: "ping",
    body: "di hola",
    hops: 0,
    requires_reply: false,
    needs_human: false,
    created_at: new Date().toISOString(),
    ...over,
  };
}

describe("Hive relay", () => {
  test("wantsReply: request/query/propose o requires_reply; inform no (antibucle)", () => {
    expect(wantsReply(msg({ act: "request" }))).toBe(true);
    expect(wantsReply(msg({ act: "query" }))).toBe(true);
    expect(wantsReply(msg({ act: "inform" }))).toBe(false);
    expect(wantsReply(msg({ act: "inform", requires_reply: true }))).toBe(true);
  });

  test("prompt tmux le dice al agente cómo contestar con hive_talk", () => {
    const p = buildRelayPrompt(msg(), "win-agent", "tmux");
    expect(p).toContain("di hola");
    expect(p).toContain('hive_talk(to="agy-victus@isymcp-dannyisyco", from="win-agent", in_reply_to="m1"');
  });

  test("tmux: pega el prompt en la sesión indicada", async () => {
    const hive = makeHive();
    const calls: string[][] = [];
    const out = await relayMessage(hive, msg(), { agentId: "win-agent", mode: "tmux", tmuxSession: "s1", tmuxSocket: "sock" }, {
      paste: (socket, session, text) => {
        calls.push([socket, session, text]);
        return { delivered: true, reason: "pasted" };
      },
    });
    expect(out.action).toBe("injected");
    expect(calls[0]![0]).toBe("sock");
    expect(calls[0]![1]).toBe("s1");
    expect(calls[0]![2]).toContain("Asunto: ping");
  });

  test("exec: stdout del CLI vuelve al remitente como inform con in_reply_to", async () => {
    const hive = makeHive();
    const replies: Array<[string, Record<string, unknown>]> = [];
    let stdinSeen = "";
    const out = await relayMessage(hive, msg(), { agentId: "win-agent", mode: "exec", execArgv: ["fake"] }, {
      exec: async (_argv, stdin) => {
        stdinSeen = stdin;
        return { code: 0, stdout: "hola desde Xeon\n", stderr: "", timedOut: false };
      },
      reply: async (to, p) => {
        replies.push([to, p as unknown as Record<string, unknown>]);
        return "r1";
      },
    });
    expect(stdinSeen).toContain("di hola");
    expect(out).toMatchObject({ action: "executed", reason: "replied", reply_id: "r1" });
    expect(replies[0]![0]).toBe("agy-victus@isymcp-dannyisyco");
    expect(replies[0]![1]).toMatchObject({ from: "win-agent", subject: "Re: ping", body: "hola desde Xeon", in_reply_to: "m1" });
  });

  test("exec: un fallo del CLI también se contesta, marcado como error", async () => {
    const hive = makeHive();
    let body = "";
    const out = await relayMessage(hive, msg(), { agentId: "win-agent", mode: "exec", execArgv: ["fake"] }, {
      exec: async () => ({ code: 3, stdout: "", stderr: "boom", timedOut: false }),
      reply: async (_to, p) => {
        body = p.body;
        return "r2";
      },
    });
    expect(out.action).toBe("failed");
    expect(out.reason).toBe("replied_with_error");
    expect(body).toContain("exit 3");
    expect(body).toContain("boom");
  });

  test("exec: no contesta a inform ni a sus propios mensajes", async () => {
    const hive = makeHive();
    const deps = {
      exec: async () => {
        throw new Error("no debía ejecutarse");
      },
    };
    const o1 = await relayMessage(hive, msg({ act: "inform" }), { agentId: "win-agent", mode: "exec", execArgv: ["x"] }, deps);
    const o2 = await relayMessage(hive, msg({ from: "win-agent" }), { agentId: "win-agent", mode: "exec", execArgv: ["x"] }, deps);
    expect(o1.action).toBe("skipped");
    expect(o2).toMatchObject({ action: "skipped", reason: "own_message" });
  });

  test("E2E local: runRelay con un CLI real (cat) entrega y la respuesta llega al inbox del remitente", async () => {
    const hive = makeHive();
    // "worker" NO está registrado: runRelay debe registrarlo (si no, el Hive descarta el mensaje).
    hive.registerLive({ id: "boss", name: "boss", harness: "test", pid: process.pid });
    const ac = new AbortController();
    const outcomes: RelayOutcome[] = [];
    const loop = runRelay(
      hive,
      { agentId: "worker", mode: "exec", execArgv: [process.platform === "win32" ? "more" : "cat"] },
      { signal: ac.signal, onOutcome: (o) => outcomes.push(o) },
    );
    const regDeadline = Date.now() + 5_000;
    while (!hive.registry().agents.worker && Date.now() < regDeadline) await new Promise((r) => setTimeout(r, 20));
    deliverLiveMessage(hive, { to: "worker", subject: "eco", body: "texto-unico-42", act: "request" }, "boss");

    const deadline = Date.now() + 10_000;
    while (outcomes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await loop;

    expect(outcomes[0]).toMatchObject({ action: "executed", from: "boss" });
    const back = readAgentInbox(hive, "boss", true);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ from: "worker", act: "inform", subject: "Re: eco" });
    expect(back[0]!.body).toContain("texto-unico-42");
  }, 20_000);

  const hasTmux = process.platform !== "win32" && spawnSync("tmux", ["-V"]).status === 0;
  test.skipIf(!hasTmux)("E2E tmux real: el mensaje aparece en el pane de la TUI", async () => {
    const hive = makeHive();
    const socket = `isymcp-relay-test-${process.pid}`;
    const session = "agent";
    spawnSync("tmux", ["-L", socket, "new-session", "-d", "-s", session, "-x", "200", "-y", "50", "cat"]);
    try {
      const out = await relayMessage(hive, msg({ body: "marca-tmux-777" }), {
        agentId: "win-agent",
        mode: "tmux",
        tmuxSession: session,
        tmuxSocket: socket,
      });
      expect(out.action).toBe("injected");
      await new Promise((r) => setTimeout(r, 300));
      const pane = spawnSync("tmux", ["-L", socket, "capture-pane", "-p", "-t", session], { encoding: "utf8" }).stdout;
      expect(pane).toContain("marca-tmux-777");
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  }, 15_000);
});
