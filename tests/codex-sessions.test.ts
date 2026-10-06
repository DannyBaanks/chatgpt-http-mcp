import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSessionByToken,
  fingerprint,
  mintSession,
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
