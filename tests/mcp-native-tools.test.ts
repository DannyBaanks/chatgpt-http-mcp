// mcp-native-tools.test.ts — pruebas vivas de las tools nativas completadas.
//
// Usa un SOLO server MCP persistente (McpClient) porque codex_write_stdin
// requiere que el exec_id viva en el proceso que spawneo el background.
//
//   TEST A  operaciones basicas: turn_start → exec escribe → apply_patch
//           (formato nativo Codex) → exec lee → turn_complete
//   TEST B  tool nativa: inventory (8 + capabilities) → tool_call con
//           wire_name valido, alias, invalido y dedupe por call_id
//   TEST C  proceso persistente: exec background → exec_id → write_stdin
//           (deltas, close_stdin, señales, ids ajenos) → turn_complete mata
//   TEST D  compatibilidad de parches: *** Begin Patch y git diff producen
//           el mismo contenido final
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintSession } from "../src/codex-sessions";
import { McpClient } from "./helpers/mcp-client";

let home: string;
let workspace: string;
let client: McpClient;
let rw: { token: string; fp: string };
let ro: { token: string; fp: string };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "isyco-native-home-"));
  workspace = mkdtempSync(join(tmpdir(), "isyco-native-ws-"));
  process.env.CODEX_WEB_HTTP_HOME = home;
  const rwSession = mintSession(workspace, { label: "rw", writable: true });
  const roSession = mintSession(workspace, { label: "ro", writable: false });
  rw = { token: rwSession.token, fp: rwSession.fp };
  ro = { token: roSession.token, fp: roSession.fp };
  client = await McpClient.start(home);
}, 30_000);

afterAll(() => {
  client?.close();
  delete process.env.CODEX_WEB_HTTP_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("TEST A — operaciones basicas con formato nativo", () => {
  test("turn_start → exec escribe → apply_patch nativo → exec lee → turn_complete", async () => {
    const start = await client.call("codex_turn_start", { turn_token: rw.token });
    expect(start.started).toBe(true);

    const write = await client.call("codex_exec", {
      turn_token: rw.token,
      command: ["sh", "-c", "printf 'primera linea\\n' > probe.txt"],
    });
    expect(write.executed).toBe(true);
    expect(write.exit_code).toBe(0);

    const patch = await client.call("codex_apply_patch", {
      turn_token: rw.token,
      patch: [
        "*** Begin Patch",
        "*** Update File: probe.txt",
        "@@",
        " primera linea",
        "+PATCHED",
        "*** End Patch",
      ].join("\n"),
    });
    expect(patch.executed).toBe(true);
    expect(patch.format).toBe("codex-native");
    expect(patch.files).toEqual(["probe.txt"]);

    const read = await client.call("codex_exec", { turn_token: rw.token, command: ["cat", "probe.txt"] });
    expect(read.exit_code).toBe(0);
    expect(read.stdout).toBe("primera linea\nPATCHED\n");

    const done = await client.call("codex_turn_complete", { turn_token: rw.token, response: String(read.stdout) });
    expect(done.completed).toBe(true);
  }, 30_000);

  test("apply_patch nativo rechazado en sesion read-only", async () => {
    const denied = await client.call("codex_apply_patch", {
      turn_token: ro.token,
      patch: ["*** Begin Patch", "*** Add File: ro.txt", "+x", "*** End Patch"].join("\n"),
    });
    expect(String(denied.error)).toContain("read-only");
  }, 30_000);

  test("apply_patch nativo con contexto inexistente no corrompe", async () => {
    await client.call("codex_exec", { turn_token: rw.token, command: ["sh", "-c", "printf 'intacto\\n' > intacto.txt"] });
    const bad = await client.call("codex_apply_patch", {
      turn_token: rw.token,
      patch: [
        "*** Begin Patch",
        "*** Update File: intacto.txt",
        "@@",
        " contexto que no existe",
        "+x",
        "*** End Patch",
      ].join("\n"),
    });
    expect(bad.error).toBeTruthy();
    const read = await client.call("codex_exec", { turn_token: ro.token, command: ["cat", "intacto.txt"] });
    expect(read.stdout).toBe("intacto\n");
  }, 30_000);
});

describe("TEST B — codex_tool_inventory y codex_tool_call", () => {
  test("inventory real: 8 tools ejecutables con capacidades", async () => {
    const inv = await client.call("codex_tool_inventory", { turn_token: rw.token });
    expect(inv.tools).toHaveLength(8);
    expect(inv.tools).toContain("codex_write_stdin");
    expect(inv.tools).toContain("codex_tool_call");
    const caps = inv.capabilities;
    expect(Array.isArray(caps)).toBe(true);
    expect(caps).toHaveLength(8);
    const execCap = (caps as Array<Record<string, unknown>>).find((c) => c.name === "codex_exec");
    expect(execCap).toBeTruthy();
    expect(execCap!.status).toBe("executable");
    expect(execCap!.arguments).toBeTruthy();
    expect(execCap!.requires).toMatchObject({ turn_token: true });
  }, 30_000);

  test("inventory stub (token sin sesion): nada ejecutable y lo dice", async () => {
    const inv = await client.call("codex_tool_inventory", { turn_token: "token-desconocido-de-mas-de-veinte-chars" });
    expect(inv.tools).toEqual([]);
    expect(String(inv.reason)).toContain("stub");
  }, 30_000);

  test("tool_call ejecuta una tool nativa real por wire_name", async () => {
    const out = await client.call("codex_tool_call", {
      turn_token: rw.token,
      wire_name: "codex_exec",
      arguments: { command: ["sh", "-c", "echo nativo"], cwd: "." },
    });
    expect(out.executed).toBe(true);
    expect(out.exit_code).toBe(0);
    expect(String(out.stdout)).toContain("nativo");
  }, 30_000);

  test("tool_call acepta el alias corto del harness", async () => {
    const out = await client.call("codex_tool_call", {
      turn_token: rw.token,
      wire_name: "exec",
      arguments: { command: ["echo", "alias"] },
    });
    expect(out.executed).toBe(true);
    expect(String(out.stdout)).toContain("alias");
  }, 30_000);

  test("tool_call con wire_name no soportado: rechazo explicito, sin inventar", async () => {
    const out = await client.call("codex_tool_call", {
      turn_token: rw.token,
      wire_name: "herramienta_inexistente",
      arguments: {},
    });
    expect(String(out.error)).toContain("no soportada");
  }, 30_000);

  test("tool_call valida arguments contra el contrato de la tool", async () => {
    const out = await client.call("codex_tool_call", {
      turn_token: rw.token,
      wire_name: "codex_exec",
      arguments: { cwd: "." }, // falta command
    });
    expect(String(out.error)).toContain("arguments no validos");
  }, 30_000);

  test("tool_call deduplica reintentos con el mismo call_id", async () => {
    const args = { command: ["sh", "-c", "echo dedupe"] };
    const first = await client.call("codex_tool_call", { turn_token: rw.token, wire_name: "codex_exec", arguments: args, call_id: "call_test_dedupe_01" });
    expect(first.executed).toBe(true);
    expect(first.replayed).toBeUndefined();
    const second = await client.call("codex_tool_call", { turn_token: rw.token, wire_name: "codex_exec", arguments: args, call_id: "call_test_dedupe_01" });
    expect(second.replayed).toBe(true);
    expect(second.stdout).toBe(first.stdout);
  }, 30_000);

  test("tool_call despacha apply_patch con la misma sesion autorizada", async () => {
    await client.call("codex_exec", { turn_token: rw.token, command: ["sh", "-c", "printf 'base\\n' > tc.txt"] });
    const out = await client.call("codex_tool_call", {
      turn_token: rw.token,
      wire_name: "apply_patch",
      arguments: {
        patch: ["*** Begin Patch", "*** Update File: tc.txt", "@@", " base", "+MAS", "*** End Patch"].join("\n"),
      },
    });
    expect(out.executed).toBe(true);
    const read = await client.call("codex_exec", { turn_token: ro.token, command: ["cat", "tc.txt"] });
    expect(read.stdout).toBe("base\nMAS\n");
  }, 30_000);
});

describe("TEST C — procesos persistentes con codex_write_stdin", () => {
  test("exec background → exec_id → write_stdin escribe y devuelve deltas → close_stdin termina", async () => {
    const spawn = await client.call("codex_exec", {
      turn_token: rw.token,
      command: ["cat"],
      background: true,
      capture_ms: 300,
    });
    expect(spawn.executed).toBe(true);
    expect(spawn.background).toBe(true);
    expect(typeof spawn.exec_id).toBe("string");
    expect(spawn.alive).toBe(true);
    const execId = String(spawn.exec_id);

    const w1 = await client.call("codex_write_stdin", { turn_token: rw.token, exec_id: execId, data: "hola\n", wait_ms: 2000 });
    expect(w1.executed).toBe(true);
    expect(w1.wrote).toBeGreaterThan(0);
    expect(String(w1.stdout)).toBe("hola\n");
    expect(w1.alive).toBe(true);

    // Solo el delta nuevo: la marca avanzo.
    const w2 = await client.call("codex_write_stdin", { turn_token: rw.token, exec_id: execId, data: "mundo\n", wait_ms: 2000 });
    expect(String(w2.stdout)).toBe("mundo\n");

    const close = await client.call("codex_write_stdin", { turn_token: rw.token, exec_id: execId, data: "", close_stdin: true, wait_ms: 2000 });
    expect(close.executed).toBe(true);
    expect(close.alive).toBe(false);
    expect(close.exit_code).toBe(0);

    // Ya muerto: rechazo explicito.
    const dead = await client.call("codex_write_stdin", { turn_token: rw.token, exec_id: execId, data: "x" });
    expect(String(dead.error)).toContain("ya termino");
  }, 30_000);

  test("proceso interactivo: read → write_stdin → respuesta", async () => {
    const spawn = await client.call("codex_exec", {
      turn_token: ro.token,
      command: ["sh", "-c", "read x; echo \"got:$x\""],
      background: true,
      capture_ms: 200,
    });
    const execId = String(spawn.exec_id);
    const reply = await client.call("codex_write_stdin", { turn_token: ro.token, exec_id: execId, data: "hi\n", wait_ms: 3000 });
    expect(reply.executed).toBe(true);
    expect(String(reply.stdout)).toContain("got:hi");
    expect(reply.alive).toBe(false);
    expect(reply.exit_code).toBe(0);
  }, 30_000);

  test("exec_id desconocido y exec_id de otra sesion: rechazados", async () => {
    const unknown = await client.call("codex_write_stdin", { turn_token: rw.token, exec_id: "exec_000000000000", data: "x" });
    expect(String(unknown.error)).toContain("desconocido");

    const spawn = await client.call("codex_exec", { turn_token: rw.token, command: ["cat"], background: true, capture_ms: 200 });
    const execId = String(spawn.exec_id);
    const ajena = await client.call("codex_write_stdin", { turn_token: ro.token, exec_id: execId, data: "x" });
    expect(String(ajena.error)).toContain("otra sesion");
  }, 30_000);

  test("turn_complete mata los procesos vivos de la sesion (sin huerfanos)", async () => {
    const spawn = await client.call("codex_exec", {
      turn_token: rw.token,
      command: ["sh", "-c", "sleep 30"],
      background: true,
      capture_ms: 200,
    });
    expect(spawn.alive).toBe(true);
    const execId = String(spawn.exec_id);

    const done = await client.call("codex_turn_complete", { turn_token: rw.token, response: "cierre" });
    expect(done.completed).toBe(true);
    expect(done.live_execs_killed).toBeGreaterThanOrEqual(1);

    const gone = await client.call("codex_write_stdin", { turn_token: rw.token, exec_id: execId, data: "x" });
    expect(String(gone.error)).toContain("desconocido");
  }, 30_000);
});

describe("TEST D — equivalencia de formatos de parche", () => {
  test("*** Begin Patch y git diff producen el mismo contenido final", async () => {
    await client.call("codex_exec", { turn_token: rw.token, command: ["sh", "-c", "mkdir -p copia_a copia_b && printf 'hola\\n' > copia_a/x.txt && printf 'hola\\n' > copia_b/x.txt"] });

    const native = await client.call("codex_apply_patch", {
      turn_token: rw.token,
      patch: ["*** Begin Patch", "*** Update File: copia_a/x.txt", "@@", " hola", "+mundo ISYMCP", "*** End Patch"].join("\n"),
    });
    expect(native.executed).toBe(true);

    const unified = await client.call("codex_apply_patch", {
      turn_token: rw.token,
      patch: [
        "--- a/copia_b/x.txt",
        "+++ b/copia_b/x.txt",
        "@@ -1 +1,2 @@",
        " hola",
        "+mundo ISYMCP",
      ].join("\n"),
    });
    expect(unified.executed).toBe(true);

    const a = await client.call("codex_exec", { turn_token: ro.token, command: ["cat", "copia_a/x.txt"] });
    const b = await client.call("codex_exec", { turn_token: ro.token, command: ["cat", "copia_b/x.txt"] });
    expect(a.stdout).toBe("hola\nmundo ISYMCP\n");
    expect(b.stdout).toBe(a.stdout);
  }, 30_000);

  test("read-only puede ejecutar el flujo de lectura completo", async () => {
    const read = await client.call("codex_exec", { turn_token: ro.token, command: ["sh", "-c", "cat probe.txt; pwd"] });
    expect(read.exit_code).toBe(0);
    expect(read.sandbox).toBe("bwrap-read-only");
    expect(String(read.stdout)).toContain("PATCHED");
  }, 30_000);
});
