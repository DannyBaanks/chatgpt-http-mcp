import { describe, expect, test } from "bun:test";
import {
  drain,
  findLive,
  killSessionExecs,
  registerLiveExec,
  sweepLiveExecs,
  type BgProc,
} from "../src/mcp/exec-registry";

function fakeProc(): {
  proc: BgProc;
  finish: (lateOutput?: boolean) => void;
  kills: number[];
} {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  const kills: number[] = [];
  let closed = false;
  const finish = (lateOutput = false) => {
    if (closed) return;
    closed = true;
    const closeStreams = () => {
      out.enqueue(new TextEncoder().encode("final stdout"));
      err.close();
      out.close();
    };
    if (lateOutput) setTimeout(closeStreams, 120);
    else closeStreams();
    resolveExit(0);
  };
  const proc: BgProc = {
    stdin: { write: () => 0, flush: () => undefined, end: () => undefined },
    stdout: new ReadableStream<Uint8Array>({ start(controller) { out = controller; } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { err = controller; } }),
    kill(signal) {
      kills.push(signal ?? 15);
      finish();
    },
    exited,
  };
  return { proc, finish, kills };
}

describe("background exec registry retry/exit lifecycle", () => {
  test("turn completion counts only processes still alive and removes completed records", async () => {
    const sessionFp = "completion-count-test";
    const child = fakeProc();
    const rec = registerLiveExec({ sessionFp, command: ["fake"], cwd: "/tmp", proc: child.proc });
    child.finish();
    await drain(rec, 500);
    expect(killSessionExecs(sessionFp)).toBe(0);
    expect(child.kills).toEqual([]);
    expect(findLive(rec.id)).toBeNull();
  });

  test("terminates the real child rejected at capacity without exceeding the cap", async () => {
    const sessionFp = "capacity-test";
    const owned: ReturnType<typeof Bun.spawn>[] = [];
    let rejected: ReturnType<typeof Bun.spawn> | undefined;
    const spawnSleep = () => Bun.spawn(["sleep", "60"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      for (let i = 0; i < 16; i++) {
        const child = spawnSleep();
        owned.push(child);
        registerLiveExec({ sessionFp, command: ["sleep", "60"], cwd: "/tmp", proc: child as unknown as BgProc });
      }
      rejected = spawnSleep();
      expect(() => registerLiveExec({
        sessionFp,
        command: ["sleep", "60"],
        cwd: "/tmp",
        proc: rejected as unknown as BgProc,
      }))
        .toThrow("limite de procesos en segundo plano alcanzado (16)");
      const termination = await Promise.race([
        rejected.exited.then((code) => ({ ended: true, code })),
        Bun.sleep(300).then(() => ({ ended: false as const })),
      ]);
      expect(termination.ended).toBe(true);
    } finally {
      killSessionExecs(sessionFp);
      try { rejected?.kill(9); } catch { /* only this test's child */ }
      for (const child of owned) {
        try { child.kill(9); } catch { /* only this test's children */ }
      }
      await Promise.allSettled([
        ...owned.map((child) => child.exited),
        ...(rejected ? [rejected.exited] : []),
      ]);
    }
  });

  test("drains bytes written after exit and retains the record until its TTL", async () => {
    const sessionFp = "exit-retention-test";
    const child = fakeProc();
    try {
      const rec = registerLiveExec({ sessionFp, command: ["fake"], cwd: "/tmp", proc: child.proc });
      child.finish(true);
      const result = await drain(rec, 1_000);
      expect(result).toEqual({ stdout: "final stdout", stderr: "", alive: false, exitCode: 0 });

      sweepLiveExecs();
      expect(findLive(rec.id)).toBe(rec);

      rec.expiresAt = Date.now() - 1;
      sweepLiveExecs();
      expect(findLive(rec.id)).toBeNull();
    } finally {
      killSessionExecs(sessionFp);
    }
  });
});
