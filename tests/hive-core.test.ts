import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveManager, redactSecrets } from "../src/hive/manager";
import { hiveWriteDecision } from "../src/hive/guard";
import { mergeTaskLedger, patchTaskInLedger } from "../src/hive/task-ledger";
import { startHiveDaemon } from "../src/hive/daemon";

const dirs: string[] = [];
function makeTmpHive(): string {
  const d = mkdtempSync(join(tmpdir(), "isymcp-hive-test-"));
  dirs.push(d);
  return join(d, "hive");
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe("Hive core headless (sin Electron)", () => {
  test("inicializa layout en disco, registra agentes y enruta outbox -> inbox", () => {
    const hiveRoot = makeTmpHive();
    const hive = new HiveManager({ hiveRoot });
    hive.ensureHive();

    expect(existsSync(join(hiveRoot, "PROTOCOL.md"))).toBe(true);
    expect(existsSync(join(hiveRoot, "registry.json"))).toBe(true);
    expect(existsSync(join(hiveRoot, "tasks.json"))).toBe(true);
    expect(existsSync(join(hiveRoot, "board.md"))).toBe(true);
    expect(existsSync(join(hiveRoot, ".git"))).toBe(true);

    const godInj = hive.ensureAgent({ id: "god", name: "Michael", cwd: hiveRoot, isGod: true });
    const workerInj = hive.ensureAgent({ id: "worker-1", name: "Dwight", cwd: hiveRoot });
    expect(godInj.env.AGENT_ID).toBe("god");
    expect(workerInj.env.HIVE_ROOT).toBe(hiveRoot);

    // Worker escribe un mensaje en su outbox -> router lo entrega al inbox de god
    writeFileSync(
      join(hiveRoot, "agents", "worker-1", "outbox", "m1.json"),
      JSON.stringify({ to: "god", act: "request", subject: "Listo", body: "Resultados en board" }),
      "utf8",
    );
    const routed = hive.routeOnce();
    expect(routed).toBe(1);

    const godInbox = hive.inbox("god");
    expect(godInbox.length).toBe(1);
    expect(godInbox[0]!.from).toBe("worker-1");
    expect(godInbox[0]!.subject).toBe("Listo");
    expect(existsSync(join(hiveRoot, "agents", "worker-1", "outbox", ".sent", "m1.json"))).toBe(true);

    // drainForStop devuelve block=true la primera vez y block=false la segunda (cursor idempotente)
    const firstDrain = hive.drainForStop("god");
    expect(firstDrain.block).toBe(true);
    expect(firstDrain.reason).toContain("Listo");
    const secondDrain = hive.drainForStop("god");
    expect(secondDrain.block).toBe(false);
  });

  test("taskLedger preserva campos extra en disco al actualizar tarjetas", () => {
    const existing = [
      { id: "t1", title: "Viejo", status: "todo", priority: 5, dependsOn: [], createdAt: "2026-01-01", customNote: "keep-me" },
    ];
    const merged = mergeTaskLedger(existing, [{ id: "t1", title: "Nuevo", status: "doing" }]);
    expect((merged[0] as Record<string, unknown>).customNote).toBe("keep-me");
    expect((merged[0] as Record<string, unknown>).status).toBe("doing");

    const patched = patchTaskInLedger(existing, "t1", { status: "done" });
    expect((patched[0] as Record<string, unknown>).customNote).toBe("keep-me");
    expect((patched[0] as Record<string, unknown>).status).toBe("done");
  });

  test("hiveGuard niega escrituras fuera de los archivos propios del agente", () => {
    const hiveRoot = "/tmp/example-hive";
    const okOwn = hiveWriteDecision({
      tool: "Write",
      toolInput: { file_path: `${hiveRoot}/agents/w1/memory.md` },
      agentId: "w1",
      isGod: false,
      hiveRoot,
      caseInsensitive: false,
    });
    expect(okOwn.deny).toBe(false);

    const denyOther = hiveWriteDecision({
      tool: "Write",
      toolInput: { file_path: `${hiveRoot}/agents/god/memory.md` },
      agentId: "w1",
      isGod: false,
      hiveRoot,
      caseInsensitive: false,
    });
    expect(denyOther.deny).toBe(true);

    const denyBoard = hiveWriteDecision({
      tool: "Edit",
      toolInput: { file_path: `${hiveRoot}/board.md` },
      agentId: "w1",
      isGod: false,
      hiveRoot,
      caseInsensitive: false,
    });
    expect(denyBoard.deny).toBe(true);

    const allowGodBoard = hiveWriteDecision({
      tool: "Edit",
      toolInput: { file_path: `${hiveRoot}/board.md` },
      agentId: "god",
      isGod: true,
      hiveRoot,
      caseInsensitive: false,
    });
    expect(allowGodBoard.deny).toBe(false);
  });

  test("redactSecrets limpia credenciales conocidas preservando texto normal", () => {
    const out = redactSecrets("commit a306d84 token=supersecret123456 Bearer abcdefgh123456");
    expect(out).toContain("commit a306d84");
    expect(out).not.toContain("supersecret123456");
    expect(out).not.toContain("abcdefgh123456");
  });

  test("HookServer headless atiende PreToolUse y Stop->drain sobre IPC local", async () => {
    const hiveRoot = makeTmpHive();
    const daemon = await startHiveDaemon({ hiveRoot, gitEnabled: false, drainOnStop: true });
    try {
      daemon.hive.ensureAgent({ id: "god", name: "Michael", cwd: hiveRoot, isGod: true });
      daemon.hive.ensureAgent({ id: "w1", name: "Jim", cwd: hiveRoot });
      daemon.hive.send({ to: "w1", act: "request", subject: "Revisa logs", body: "Urgente" }, "god");

      const sendFrame = (payload: Record<string, unknown>) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const c = createConnection(daemon.sockPath!, () => {
            c.write(`${JSON.stringify(payload)}\n`);
          });
          let buf = "";
          c.setEncoding("utf8");
          c.on("data", (d) => {
            buf += d;
          });
          c.on("end", () => resolve(JSON.parse(buf || "{}")));
          c.on("error", reject);
        });

      const stopResp = await sendFrame({ hook_event_name: "Stop", agent_id: "w1" });
      expect(stopResp.decision).toBe("block");
      expect(String(stopResp.reason)).toContain("Revisa logs");

      const guardResp = await sendFrame({
        hook_event_name: "PreToolUse",
        agent_id: "w1",
        tool_name: "Write",
        tool_input: { file_path: join(hiveRoot, "registry.json") },
      });
      const out = guardResp.hookSpecificOutput as Record<string, unknown>;
      expect(out.permissionDecision).toBe("deny");
    } finally {
      daemon.stop();
    }
  });
});
