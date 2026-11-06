import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPrivate } from "./helpers/private-mode";
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
  test("procesos concurrentes no pierden escrituras del registro (revoke incluido)", async () => {
    const victim = mintSession(workspace, { label: "victim" });
    const module = fileURLToPath(new URL("../src/codex-sessions.ts", import.meta.url));
    const script = `const m = await import(${JSON.stringify(module)}); const [cwd, id] = process.argv.slice(-2);
      for (let i = 0; i < 15; i++) m.mintSession(cwd, { label: "w" + id + "-" + i });`;
    const env = { ...process.env, CODEX_WEB_HTTP_HOME: home };
    const writers = Array.from({ length: 4 }, (_, id) =>
      Bun.spawn([process.execPath, "-e", script, workspace, String(id)], { env, stdout: "ignore", stderr: "pipe" }));
    expect(revokeSession(victim.fp)).toBe(1);
    const codes = await Promise.all(writers.map((w) => w.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    const labels = readSessions().map((s) => s.label);
    expect(labels.filter((l) => /^w\d-\d+$/.test(l))).toHaveLength(60);
    expect(labels).not.toContain("victim");
  }, 30_000);

  test("un lector concurrente no deshace la publicacion del registro", async () => {
    mintSession(workspace, { label: "semilla" });
    const path = registryPath();
    // El lector abre y cierra el destino en cada lectura, que es exactamente lo que hace
    // cualquier MCP call sobre codex-sessions.json. En Windows ese handle tan breve le
    // quita al rename el acceso de borrado que MoveFileEx exige (EPERM: -4048); en POSIX
    // es inofensivo. La propiedad afirmada es la misma en los dos sistemas: lo minteado
    // llega a disco. Medido antes del arreglo: 2490 EPERM contra 325 publicaciones.
    const reader = Bun.spawn([process.execPath, "-e", `const { openSync, closeSync } = await import("node:fs");
      const p = process.argv.at(-1); const until = Date.now() + 2000;
      while (Date.now() < until) { try { const fd = openSync(p, "r"); closeSync(fd); } catch { /* entre publicacion y publicacion */ } }`,
      path], { env: { ...process.env, CODEX_WEB_HTTP_HOME: home }, stdout: "ignore", stderr: "pipe" });
    for (let i = 0; i < 25; i++) mintSession(workspace, { label: `pub-${i}` });
    expect(await reader.exited).toBe(0);
    expect(readSessions().map((s) => s.label).filter((l) => /^pub-\d+$/.test(l))).toHaveLength(25);
    // El tmp contiene tokens de sesion: no puede quedar ni siquiera cuando el rename
    // necesito reintentar, o cada choque dejaria capacidades grabadas en el HOME.
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
  }, 30_000);

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
  }, 30_000);
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
    // Un symlink de ARCHIVO pide Modo desarrollador en Windows (EPERM); la junction a
    // un directorio conserva la afirmacion: el enlace esta dentro del workspace y su
    // destino real esta afuera (src/codex-sessions.ts:149 resuelve por realpath aqui).
    const win32 = process.platform === "win32";
    const link = join(workspace, "link");
    if (win32) symlinkSync(home, link, "junction");
    else symlinkSync(outside, join(workspace, "linked.md"));
    writeFileSync(join(workspace, "binary.md"), Buffer.from([0xff, 0xfe]));
    writeFileSync(join(workspace, "large.md"), "x".repeat(65537));
    const escaped = win32 ? join("link", "outside.md") : "linked.md";
    try {
      for (const requestFile of [outside, "../outside.md", escaped, "binary.md", "large.md", "missing.md"])
        expect(() => mintSession(workspace, { requestFile })).toThrow();
      expect(readSessions()).toHaveLength(0);
      expect(readSessionRequest(mintSession(workspace))).toBeNull();
    } finally {
      if (win32 && existsSync(link)) rmdirSync(link);
    }
  });
  test("mint crea registro 0600 con token opaco y fingerprint estable", () => {
    const session = mintSession(workspace, { label: "test", writable: false });
    expect(session.token.length).toBeGreaterThanOrEqual(32);
    expect(session.fp).toBe(fingerprint(session.token));
    expect(session.cwd).toBe(workspace);
    expect(session.writable).toBe(false);

    expectPrivate(registryPath(), false);

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
  // node:path decide "escape" con la semantica del host: en Windows una raiz "/ws"
  // significa "la raiz de la unidad actual", no un workspace. La tabla POSIX queda
  // intacta y se anade su analogo nativo, incl. el salto de unidad.
  const win32 = process.platform === "win32";
  const cases: [string, string | null][] = win32
    ? [
        ["sub\\x", "C:\\ws\\sub\\x"],
        [".", "C:\\ws"],
        ["..\\x", null],
        ["D:\\otro\\x", null],
        ["C:\\Windows\\win.ini", null],
        ["sub\\..\\..\\x", null],
      ]
    : [
        ["sub/x", "/ws/sub/x"],
        [".", "/ws"],
        ["../x", null],
        ["/etc/passwd", null],
        ["sub/../../x", null],
      ];
  test("resolveWithin permite adentro y niega escapes", () => {
    const root = win32 ? "C:\\ws" : "/ws";
    for (const [candidate, expected] of cases) expect(resolveWithin(root, candidate)).toBe(expected);
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
