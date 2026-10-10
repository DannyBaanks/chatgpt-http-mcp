import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  findSessionByToken,
  fingerprint,
  mintSession,
  mintTurnToken,
  readSessionRequest,
  patchPaths,
  readSessions,
  registryPath,
  resolveWithin,
  revokeSession,
} from "../src/codex-sessions";

let home: string;
let workspace: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "isyco-sessions-home-"));
  workspace = mkdtempSync(join(tmpdir(), "isyco-sessions-ws-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
});

afterEach(() => {
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("codex-sessions registry", () => {
  test("CLI binds a local task and emits a four-line MCP command without pasting task content", () => {
    const task = "PRIVATE_LOCAL_TASK_ONLY_4_LINES";
    writeFileSync(join(workspace, "TASK.md"), task);
    const result = Bun.spawnSync([process.execPath, "run", fileURLToPath(new URL("../src/isymcp.ts", import.meta.url)),
      "session", "mint", "--cwd", workspace, "--request-file", "TASK.md"],
      { env: { ...process.env, CODEX_WEB_HTTP_HOME: home } });
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(output).not.toContain(task);
    const command = output.split("pegar:\n")[1]!.trim().split("\n");
    expect(command).toHaveLength(4);
    expect(command[0]).toContain("@CODEX ISYMCP");
    expect(command[1]).toContain("turn_token:");
    expect(command[2]).toContain("bootstrap.content");
    expect(command[3]).toContain("request.content");
    const session = readSessions()[0]!;
    expect(readSessionRequest(session)?.content).toBe(task);
    const invalid = Bun.spawnSync([process.execPath, "run", fileURLToPath(new URL("../src/isymcp.ts", import.meta.url)),
      "session", "mint", "--cwd", workspace, "--request-file"],
      { env: { ...process.env, CODEX_WEB_HTTP_HOME: home } });
    expect(invalid.exitCode).not.toBe(0);
    expect(readSessions()).toHaveLength(1);
  });
  test("an explicitly linked local request is hash-pinned and inherited by its turn", () => {
    writeFileSync(join(workspace, "TASK.md"), "Read the local project status.");
    const session = mintSession(workspace, { requestFile: "TASK.md" });
    expect(readSessionRequest(session)).toMatchObject({ filename: "TASK.md", content: "Read the local project status." });
    const turn = mintTurnToken(session.fp, "turn-with-request");
    expect(readSessionRequest(turn)).toEqual(readSessionRequest(session));
    writeFileSync(join(workspace, "TASK.md"), "Different task not authorized by this token.");
    expect(() => readSessionRequest(session)).toThrow("request_changed");
  });
  test("a UTF-8 BOM is preserved so returned content matches the recorded SHA", () => {
    const task = "\uFEFFRead the local project status.";
    writeFileSync(join(workspace, "TASK.md"), task);
    const request = readSessionRequest(mintSession(workspace, { requestFile: "TASK.md" }))!;
    expect(request.content).toBe(task);
    expect(createHash("sha256").update(request.content).digest("hex")).toBe(request.sha256);
  });

  test("local requests reject paths outside the workspace, links, binary and oversized content", () => {
    const outside = join(home, "outside.md"); writeFileSync(outside, "secret task");
    symlinkSync(outside, join(workspace, "linked.md"));
    writeFileSync(join(workspace, "binary.md"), Buffer.from([0xff, 0xfe]));
    writeFileSync(join(workspace, "large.md"), "x".repeat(65537));
    for (const requestFile of [outside, "../outside.md", "linked.md", "binary.md", "large.md", "missing.md"])
      expect(() => mintSession(workspace, { requestFile })).toThrow();
    expect(readSessions()).toHaveLength(0);
    expect(readSessionRequest(mintSession(workspace))).toBeNull();
  });
  test("mint crea registro 0600 con token opaco y fingerprint estable", () => {
    const session = mintSession(workspace, { label: "test", writable: false });
    expect(session.token.length).toBeGreaterThanOrEqual(32);
    expect(session.fp).toBe(fingerprint(session.token));
    expect(session.cwd).toBe(workspace);
    expect(session.writable).toBe(false);

    const mode = statSync(registryPath()).mode & 0o777;
    expect(mode).toBe(0o600);

    const listed = readSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.label).toBe("test");
  });

  test("findSessionByToken encuentra solo el token exacto", () => {
    const session = mintSession(workspace);
    expect(findSessionByToken(session.token)?.fp).toBe(session.fp);
    expect(findSessionByToken(`${session.token}x`)).toBeNull();
    expect(findSessionByToken(session.token.slice(0, 20))).toBeNull();
  });

  test("revoke por prefijo y por fp elimina la sesion", () => {
    const a = mintSession(workspace, { label: "a" });
    const b = mintSession(workspace, { label: "b" });
    expect(revokeSession(a.token.slice(0, 8))).toBe(1);
    expect(findSessionByToken(a.token)).toBeNull();
    expect(findSessionByToken(b.token)?.label).toBe("b");
    expect(revokeSession(b.fp.slice(0, 6))).toBe(1);
    expect(readSessions()).toHaveLength(0);
    expect(revokeSession("no-existe")).toBe(0);
  });

  test("mint rechaza cwd relativo o inexistente", () => {
    expect(() => mintSession("relativo")).toThrow();
    expect(() => mintSession(join(workspace, "nope"))).toThrow();
  });
});

describe("confinamiento de paths", () => {
  test("resolveWithin permite adentro y niega escapes", () => {
    expect(resolveWithin("/ws", "sub/x")).toBe("/ws/sub/x");
    expect(resolveWithin("/ws", ".")).toBe("/ws");
    expect(resolveWithin("/ws", "../x")).toBeNull();
    expect(resolveWithin("/ws", "/etc/passwd")).toBeNull();
    expect(resolveWithin("/ws", "sub/../../x")).toBeNull();
  });

  test("patchPaths extrae diff unificado y detecta formato Codex", () => {
    const unified = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    const parsed = patchPaths(unified);
    expect(parsed.codexFormat).toBe(false);
    expect(parsed.paths).toEqual(["src/a.ts", "src/a.ts"]);

    const codex = "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch";
    expect(patchPaths(codex).codexFormat).toBe(true);
  });
});
