// codex-patch.test.ts — unitario del formato nativo Codex (*** Begin Patch).
// Todo contra un directorio temporal; nada toca el repo.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexPatchError, applyCodexPatch } from "../src/mcp/codex-patch";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isyco-codex-patch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string) {
  writeFileSync(join(dir, name), content);
}

function read(name: string) {
  return readFileSync(join(dir, name), "utf8");
}

describe("codex-patch: Update File", () => {
  test("agrega una linea al final (ejemplo del compose)", () => {
    write("probe.txt", "primera linea\n");
    const files = applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Update File: probe.txt",
      "@@",
      " primera linea",
      "+PATCHED",
      "*** End Patch",
    ].join("\n"));
    expect(files).toEqual(["probe.txt"]);
    expect(read("probe.txt")).toBe("primera linea\nPATCHED\n");
  });

  test("reemplaza una linea en el medio con contexto alrededor", () => {
    write("a.txt", "uno\ndos\ntres\n");
    applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " uno",
      "-dos",
      "+DOS",
      " tres",
      "*** End Patch",
    ].join("\n"));
    expect(read("a.txt")).toBe("uno\nDOS\ntres\n");
  });

  test("multi-hunk: dos cambios en un archivo", () => {
    write("b.txt", "alpha\nbeta\ngamma\ndelta\n");
    applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Update File: b.txt",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      "@@",
      " gamma",
      "-delta",
      "+DELTA",
      "*** End Patch",
    ].join("\n"));
    expect(read("b.txt")).toBe("alpha\nBETA\ngamma\nDELTA\n");
  });

  test("lineas de contexto vacias: espacio y linea vacia valen lo mismo", () => {
    write("c.txt", "x\n\ny\n");
    applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Update File: c.txt",
      "@@",
      " x",
      "",
      "+nuevo",
      " y",
      "*** End Patch",
    ].join("\n"));
    expect(read("c.txt")).toBe("x\n\nnuevo\ny\n");
  });

  test("conserva la ausencia de newline final cuando no se toca la ultima linea", () => {
    write("d.txt", "uno\ndos"); // sin \n final
    applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Update File: d.txt",
      "@@",
      "-uno",
      "+UNO",
      " dos",
      "*** End Patch",
    ].join("\n"));
    expect(read("d.txt")).toBe("UNO\ndos");
  });

  test("regla deterministica: reemplazar la ultima linea define newline final", () => {
    write("d2.txt", "uno\ndos"); // sin \n final
    applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Update File: d2.txt",
      "@@",
      " uno",
      "-dos",
      "+DOS",
      "*** End Patch",
    ].join("\n"));
    expect(read("d2.txt")).toBe("uno\nDOS\n");
  });

  test("contexto repetido: ubica la ocurrencia correcta con contexto inicial", () => {
    write("e.txt", "tag\nvalor\ntag\notro\n");
    applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Update File: e.txt",
      "@@",
      " valor",
      "-tag",
      "+tag-sustituido",
      "*** End Patch",
    ].join("\n"));
    expect(read("e.txt")).toBe("tag\nvalor\ntag-sustituido\notro\n");
  });

  test("pista @@ -N cuando el hunk no arranca con contexto", () => {
    write("f.txt", "a\nb\nc\n");
    applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@ -2 +2 @@",
      "-b",
      "+B",
      " c",
      "*** End Patch",
    ].join("\n"));
    expect(read("f.txt")).toBe("a\nB\nc\n");
  });

  test("rechaza contexto que no coincide y NO toca el archivo", () => {
    write("g.txt", "original\n");
    expect(() => applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Update File: g.txt",
      "@@",
      " contexto-que-no-existe",
      "+x",
      "*** End Patch",
    ].join("\n"))).toThrow(CodexPatchError);
    expect(read("g.txt")).toBe("original\n");
  });

  test("hunk sin contexto ni pista: rechazo explicito", () => {
    write("h.txt", "uno\n");
    expect(() => applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Update File: h.txt",
      "@@",
      "+solo adiciones",
      "*** End Patch",
    ].join("\n"))).toThrow(/contexto/);
    expect(read("h.txt")).toBe("uno\n");
  });

  test("archivo inexistente en Update: rechazo", () => {
    expect(() => applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Update File: no-existe.txt",
      "@@",
      " x",
      "+y",
      "*** End Patch",
    ].join("\n"))).toThrow(/no existe/);
  });
});

describe("codex-patch: Add y Delete File", () => {
  test("Add File crea el contenido exacto", () => {
    applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Add File: nuevo.txt",
      "+linea 1",
      "+",
      "+linea 3",
      "*** End Patch",
    ].join("\n"));
    expect(read("nuevo.txt")).toBe("linea 1\n\nlinea 3\n");
  });

  test("Add File sobre existente: rechazo sin tocarlo", () => {
    write("ya.txt", "contenido\n");
    expect(() => applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Add File: ya.txt",
      "+x",
      "*** End Patch",
    ].join("\n"))).toThrow(/ya existe/);
    expect(read("ya.txt")).toBe("contenido\n");
  });

  test("Delete File elimina el archivo", () => {
    write("morir.txt", "x\n");
    applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Delete File: morir.txt",
      "*** End Patch",
    ].join("\n"));
    expect(existsSync(join(dir, "morir.txt"))).toBe(false);
  });

  test("Delete File inexistente: rechazo", () => {
    expect(() => applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Delete File: fantasma.txt",
      "*** End Patch",
    ].join("\n"))).toThrow(/no existe/);
  });
});

describe("codex-patch: validacion y confinement", () => {
  for (const failRollback of [false, true]) test(`publication failure ${failRollback ? "preserves a usable recovery backup" : "rolls back the already published file"}`, () => {
    write("first.txt", "original\n");
    write("second.txt", "second\n");
    const modulePath = new URL("../src/mcp/codex-patch.ts", import.meta.url).href;
    // Isolated process: the injected filesystem failure never changes other tests.
    const source = `
      import { mock } from "bun:test";
      import * as fs from "node:fs";
      const original = { ...fs };
      mock.module("node:fs", () => ({ ...original, renameSync(from, to) {
        if (String(to).endsWith("/second.txt") || (${failRollback} && String(from).includes(".isymcp-backup-")))
          throw new Error("injected publication failure");
        return original.renameSync(from, to);
      } }));
      const { applyCodexPatch } = await import(${JSON.stringify(modulePath)});
      let error = "";
      try { applyCodexPatch(${JSON.stringify(dir)}, "*** Begin Patch\\n*** Update File: first.txt\\n@@\\n-original\\n+changed\\n*** Update File: second.txt\\n@@\\n-second\\n+updated\\n*** End Patch"); }
      catch (e) { error = e.message; }
      console.log(JSON.stringify({ error, first: original.readFileSync(${JSON.stringify(join(dir, "first.txt"))}, "utf8"), files: original.readdirSync(${JSON.stringify(dir)}) }));
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.error).toContain("injected publication failure");
    expect(read("second.txt")).toBe("second\n");
    if (!failRollback) {
      expect(result.first).toBe("original\n");
      expect(result.files.sort()).toEqual(["first.txt", "second.txt"]);
    } else {
      expect(result.error).toContain("rollback incompleto");
      const backups = result.error.split("backups conservados: ")[1].split(", ");
      expect(backups.length).toBe(1);
      expect(backups[0]).toStartWith(dir + "/");
      expect(readFileSync(backups[0], "utf8")).toBe("original\n");
    }
  });

  test("a symlink parent cannot write outside the authorized root", () => {
    const outside = mkdtempSync(join(tmpdir(), "isyco-patch-outside-"));
    try {
      symlinkSync(outside, join(dir, "link"));
      expect(() => applyCodexPatch(dir, "*** Begin Patch\n*** Add File: link/escape.txt\n+x\n*** End Patch")).toThrow(CodexPatchError);
      expect(existsSync(join(outside, "escape.txt"))).toBe(false);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  test("invalid parent in a later operation leaves earlier files unchanged", () => {
    write("first.txt", "original\n");
    write("blocked", "not a directory\n");
    expect(() => applyCodexPatch(dir, "*** Begin Patch\n*** Update File: first.txt\n@@\n-original\n+changed\n*** Add File: blocked/child.txt\n+x\n*** End Patch")).toThrow(CodexPatchError);
    expect(read("first.txt")).toBe("original\n");
  });

  test("new directory parents are created only for a fully valid patch", () => {
    write("first.txt", "original\n");
    applyCodexPatch(dir, "*** Begin Patch\n*** Update File: first.txt\n@@\n-original\n+changed\n*** Add File: new/nested/child.txt\n+x\n*** End Patch");
    expect(read("first.txt")).toBe("changed\n");
    expect(read("new/nested/child.txt")).toBe("x\n");
  });

  test("normalized duplicate paths fail before any publication", () => {
    expect(() => applyCodexPatch(dir, "*** Begin Patch\n*** Add File: same.txt\n+x\n*** Add File: ./same.txt\n+y\n*** End Patch")).toThrow(/repetida/);
    expect(existsSync(join(dir, "same.txt"))).toBe(false);
  });

  test("a staging IO failure does not publish an earlier update", () => {
    if (process.getuid?.() === 0) return; // root bypasses filesystem permissions
    write("first.txt", "original\n");
    mkdirSync(join(dir, "read-only"));
    chmodSync(join(dir, "read-only"), 0o555);
    try {
      expect(() => applyCodexPatch(dir, "*** Begin Patch\n*** Update File: first.txt\n@@\n-original\n+changed\n*** Add File: read-only/child.txt\n+x\n*** End Patch")).toThrow(CodexPatchError);
      expect(read("first.txt")).toBe("original\n");
    } finally { chmodSync(join(dir, "read-only"), 0o755); }
  });

  test("ruta que escapa del workspace: rechazo", () => {
    expect(() => applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Add File: ../fuera.txt",
      "+x",
      "*** End Patch",
    ].join("\n"))).toThrow(/fuera del workspace/);
    expect(existsSync(join(dir, "..", "fuera.txt"))).toBe(false);
  });

  test("sin *** End Patch: rechazo", () => {
    expect(() => applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Add File: x.txt",
      "+x",
    ].join("\n"))).toThrow(/End Patch/);
  });

  test("contenido despues de *** End Patch: rechazo", () => {
    expect(() => applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Add File: x.txt",
      "+x",
      "*** End Patch",
      "+basura",
    ].join("\n"))).toThrow(/despues/);
  });

  test("directiva desconocida: rechazo", () => {
    expect(() => applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Move to: otro.txt",
      "*** End Patch",
    ].join("\n"))).toThrow(/directiva/);
  });

  test("ruta repetida: rechazo", () => {
    expect(() => applyCodexPatch(dir, [
      "*** Begin Patch",
      "*** Add File: dup.txt",
      "+a",
      "*** Delete File: dup.txt",
      "*** End Patch",
    ].join("\n"))).toThrow(/repetida/);
  });

  test("sin operaciones: rechazo", () => {
    expect(() => applyCodexPatch(dir, "*** Begin Patch\n*** End Patch")).toThrow(/operaciones/);
  });

  test("valida TODO antes de escribir: el segundo archivo falla y el primero queda intacto", () => {
    write("primero.txt", "intacto\n");
    const patch = [
      "*** Begin Patch",
      "*** Add File: primero.txt",
      "+no deberia aplicar",
      "*** Add File: segundo.txt",
      "+x",
      "*** End Patch",
    ].join("\n");
    expect(() => applyCodexPatch(dir, patch)).toThrow(/ya existe/);
    expect(read("primero.txt")).toBe("intacto\n");
    expect(existsSync(join(dir, "segundo.txt"))).toBe(false);
  });
});
