import { describe, expect, test } from "bun:test";
import { HiveManager } from "../src/hive/manager";
import { quoteForWindowsShell, relayCommand } from "../src/hive/relay-access";
import { relayMessage, runRelay, type RelayOutcome } from "../src/hive/relay";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("relay access modes", () => {
  test("claude: none = sin herramientas; ro/rw = restricted con tools acotadas; full = bypass", () => {
    const none = relayCommand("claude", "none", { cwd: "/w" }).argv;
    expect(none).toEqual(["claude", "-p", "--permission-prompts", "none", "--tools", "", "--strict-mcp-config"]);
    const ro = relayCommand("claude", "ro", { cwd: "/w" }).argv;
    expect(ro).toContain("--restricted");
    expect(ro[ro.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    const rw = relayCommand("claude", "rw", { cwd: "/w" }).argv;
    expect(rw[rw.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Edit,Write");
    expect(rw[rw.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    const full = relayCommand("claude", "full", { cwd: "/w", forRaw: "2h", now: 1000 });
    expect(full.argv).toContain("--dangerously-skip-permissions");
    expect(full.expiresAt).toBe(1000 + 2 * 3600_000);
  });

  test("codex: sandbox propio por modo; none se rechaza (no puede quitar herramientas)", () => {
    expect(relayCommand("codex", "ro", { cwd: "/w" }).argv).toEqual(["codex", "exec", "--skip-git-repo-check", "-C", "/w", "--sandbox", "read-only"]);
    expect(relayCommand("codex", "rw", { cwd: "/w" }).argv.slice(-2)).toEqual(["--sandbox", "workspace-write"]);
    expect(relayCommand("codex", "full", { cwd: "/w", forRaw: "30m" }).argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(() => relayCommand("codex", "none", { cwd: "/w" })).toThrow(/read-only/);
  });

  test("isycode: ro = classic, full = flow; none/rw se rechazan (flow también ejecuta comandos)", () => {
    expect(relayCommand("isycode", "ro", { cwd: "/w" }).argv).toEqual(["isycode", "-p", "--mode", "classic"]);
    expect(relayCommand("isycode", "full", { cwd: "/w", forRaw: "1h" }).argv).toEqual(["isycode", "-p", "--mode", "flow"]);
    expect(() => relayCommand("isycode", "none", { cwd: "/w" })).toThrow(/classic/);
    expect(() => relayCommand("isycode", "rw", { cwd: "/w" })).toThrow(/flow/);
  });

  test("openisy: servidor privado + permisos por OPENCODE_CONFIG_CONTENT", () => {
    const perm = (a: string, f?: string) => {
      const c = relayCommand("openisy", a, { cwd: "/w", forRaw: f });
      expect(c.argv.slice(0, 3)).toEqual(["openisy", "run", "--standalone"]);
      return { argv: c.argv, p: JSON.parse(c.env!.OPENCODE_CONFIG_CONTENT!).permission };
    };
    expect(perm("none").p).toEqual({ "*": "deny" });
    expect(perm("ro").p).toEqual({ "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" });
    const rw = perm("rw").p;
    expect(rw.edit).toBe("allow");
    expect(rw.external_directory).toBe("deny");
    expect(rw.bash).toBeUndefined();
    const full = perm("full", "2h");
    expect(full.p).toEqual({ "*": "allow" });
    expect(full.argv).toContain("--auto");
    expect(perm("ro").argv).not.toContain("--auto");
  });

  test("full exige --for <=24h; --for fuera de full y valores desconocidos fallan cerrado", () => {
    expect(() => relayCommand("claude", "full", { cwd: "/w" })).toThrow(/--for/);
    expect(() => relayCommand("claude", "full", { cwd: "/w", forRaw: "25h" })).toThrow(/24h/);
    expect(() => relayCommand("claude", "ro", { cwd: "/w", forRaw: "1h" })).toThrow(/solo aplica/);
    expect(() => relayCommand("gemini", "ro", { cwd: "/w" })).toThrow(/no soportado/);
    expect(() => relayCommand("claude", "admin", { cwd: "/w" })).toThrow(/inválido/);
  });

  test("quoteForWindowsShell conserva el argumento vacío y los espacios", () => {
    expect(quoteForWindowsShell("")).toBe('""');
    expect(quoteForWindowsShell("Read,Glob,Grep")).toBe('"Read,Glob,Grep"');
    expect(quoteForWindowsShell("C:\\a b")).toBe('"C:\\a b"');
    expect(quoteForWindowsShell("-p")).toBe("-p");
  });

  test("acceso caducado: no ejecuta y el bucle se apaga solo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isymcp-relay-access-"));
    try {
      const hive = new HiveManager({ hiveRoot: dir });
      hive.ensureHive();
      const msg = {
        id: "m", conversation: "c", in_reply_to: null, from: "boss", to: "w", act: "request" as const,
        subject: "s", body: "b", hops: 0, requires_reply: false, needs_human: false, created_at: "",
      };
      const deps = { exec: async () => { throw new Error("no debía ejecutar"); } };
      const out = await relayMessage(hive, msg, { agentId: "w", mode: "exec", execArgv: ["x"], expiresAt: 10, now: () => 11 }, deps);
      expect(out).toMatchObject({ action: "skipped", reason: "access_expired" });
      const seen: RelayOutcome[] = [];
      await runRelay(hive, { agentId: "w", mode: "exec", execArgv: ["x"], expiresAt: 10, now: () => 11 }, { onOutcome: (o) => seen.push(o), deps });
      expect(seen.at(-1)?.reason).toBe("access_expired_relay_stopped");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
