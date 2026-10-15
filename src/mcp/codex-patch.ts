// codex-patch.ts — aplicador del formato nativo Codex (*** Begin Patch).
//
// codex_apply_patch acepta DOS formatos: diff unificado (via `git apply`,
// en main.ts) y el formato nativo de Codex, que se aplica aqui. El diseño
// es fail-closed: primero se valida y calcula TODO el contenido nuevo en
// memoria; solo si todo cuadra se escribe. Un patch invalido nunca toca
// disco (no corrompe el archivo).
//
// Gramatica soportada (la del tool apply_patch de Codex):
//   *** Begin Patch
//   *** Update File: ruta        → hunks @@ con lineas ' ctx', '-del', '+add'
//   *** Add File: ruta           → solo lineas '+contenido'
//   *** Delete File: ruta        → sin cuerpo
//   *** End Patch
//
// Reglas de ubicacion de hunks (Update): el run de contexto inicial ubica
// el hunk; si no hay, se usa la pista explicita de `@@ -N`; si tampoco, se
// busca la ventana completa (ctx+del) en orden. El candidato SIEMPRE se
// verifica contra el archivo real antes de aplicar: si nada cuadra, rechazo.
import { closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class CodexPatchError extends Error {}

interface HunkLine {
  kind: "ctx" | "del" | "add";
  text: string;
}

interface Hunk {
  lines: HunkLine[];
  /** Linea inicial (-N) del marcador @@, si el modelo la incluyo. */
  oldStartHint: number | null;
}

type FileOp =
  | { op: "update"; path: string; hunks: Hunk[] }
  | { op: "add"; path: string; lines: string[] }
  | { op: "delete"; path: string };

const DIRECTIVE = /^\*\*\* (Update|Add|Delete) File: (.*)$/;

function parseHint(line: string): number | null {
  const m = /^@@\s*-(\d+)(?:,\d+)?(?:\s*\+\d+(?:,\d+)?)?\s*@@?/.exec(line);
  return m ? Number(m[1]) : null;
}

function parse(patch: string): FileOp[] {
  const raw = patch.split("\n").map((l) => l.replace(/\r$/, ""));
  let i = 0;
  while (i < raw.length && raw[i]!.trim() === "") i++;
  if (raw[i] !== "*** Begin Patch") {
    throw new CodexPatchError("formato Codex: falta '*** Begin Patch'");
  }
  i++;
  const ops: FileOp[] = [];
  let cur: FileOp | null = null;
  let curHunk: Hunk | null = null;
  let ended = false;
  for (; i < raw.length; i++) {
    const line = raw[i]!;
    if (line.trim() === "*** End Patch") {
      ended = true;
      i++;
      break;
    }
    const directive = DIRECTIVE.exec(line);
    if (directive) {
      const [, kind, rawPath] = directive as unknown as [string, "Update" | "Add" | "Delete", string];
      const path = rawPath.trim();
      if (!path) throw new CodexPatchError(`*** ${kind} File sin ruta`);
      if (ops.some((o) => o.path === path)) {
        throw new CodexPatchError(`ruta repetida en el patch: ${path}`);
      }
      cur = kind === "Update" ? { op: "update", path, hunks: [] } : kind === "Add" ? { op: "add", path, lines: [] } : { op: "delete", path };
      ops.push(cur);
      curHunk = null;
      continue;
    }
    if (line.startsWith("***")) {
      throw new CodexPatchError(`directiva no soportada en el patch: ${line}`);
    }
    if (!cur) throw new CodexPatchError(`contenido antes de una directiva *** File: ${line}`);
    if (cur.op === "add") {
      if (line.startsWith("+")) cur.lines.push(line.slice(1));
      else if (line === "") cur.lines.push("");
      else throw new CodexPatchError(`linea sin '+' en Add File ${cur.path}: ${JSON.stringify(line)}`);
      continue;
    }
    if (cur.op === "delete") {
      if (line.trim() !== "") throw new CodexPatchError(`Delete File ${cur.path} no admite contenido`);
      continue;
    }
    // Update File: '@@' abre hunk nuevo; cualquier otra linea es contenido.
    if (line.startsWith("@@")) {
      curHunk = { lines: [], oldStartHint: parseHint(line) };
      cur.hunks.push(curHunk);
      continue;
    }
    if (!curHunk) {
      curHunk = { lines: [], oldStartHint: null };
      cur.hunks.push(curHunk);
    }
    if (line === "") curHunk.lines.push({ kind: "ctx", text: "" });
    else if (line.startsWith("+")) curHunk.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) curHunk.lines.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) curHunk.lines.push({ kind: "ctx", text: line.slice(1) });
    else throw new CodexPatchError(`linea invalida en Update File ${cur.path} (debe empezar con '+', '-', espacio o estar vacia): ${JSON.stringify(line)}`);
  }
  if (!ended) throw new CodexPatchError("formato Codex: falta '*** End Patch'");
  for (; i < raw.length; i++) {
    if (raw[i]!.trim() !== "") throw new CodexPatchError("contenido despues de '*** End Patch'");
  }
  if (ops.length === 0) throw new CodexPatchError("el patch no contiene operaciones de archivo");
  return ops;
}

function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === "") return { lines: [], finalNewline: true };
  const finalNewline = text.endsWith("\n");
  return { lines: (finalNewline ? text.slice(0, -1) : text).split("\n"), finalNewline };
}

/**
 * Ubica el inicio de un hunk en el archivo original (indice 0-based, desde
 * `from`). El candidato se verifica completo (ctx+del en orden); el primer
 * candidato que cuadra gana. Ninguno cuadra => rechazo, sin tocar nada.
 */
function locate(lines: string[], from: number, hunk: Hunk, path: string): number {
  const expected: string[] = [];
  for (const item of hunk.lines) if (item.kind !== "add") expected.push(item.text);
  if (expected.length === 0) {
    throw new CodexPatchError(`hunk sin contexto ni eliminaciones en ${path}: incluye lineas de contexto para ubicarlo`);
  }
  const candidates: number[] = [];
  const leading: string[] = [];
  for (const item of hunk.lines) {
    if (item.kind === "ctx") leading.push(item.text);
    else break;
  }
  if (leading.length > 0) {
    for (let i = from; i + leading.length <= lines.length; i++) {
      if (leading.every((t, j) => lines[i + j] === t)) candidates.push(i);
    }
  } else if (hunk.oldStartHint != null && hunk.oldStartHint - 1 >= from) {
    candidates.push(hunk.oldStartHint - 1);
  } else {
    for (let i = from; i + expected.length <= lines.length; i++) candidates.push(i);
  }
  for (const start of candidates) {
    if (start + expected.length > lines.length) continue;
    if (expected.every((t, j) => lines[start + j] === t)) return start;
  }
  throw new CodexPatchError(`contexto no coincide en ${path}: el hunk no se ubica en el archivo actual`);
}

/** Aplica los hunks de un Update File y devuelve el contenido NUEVO completo. */
function applyUpdate(original: string, op: { path: string; hunks: Hunk[] }): string {
  const { lines, finalNewline } = splitLines(original);
  if (op.hunks.length === 0) throw new CodexPatchError(`Update File sin hunks: ${op.path}`);
  const out: string[] = [];
  let origIdx = 0;
  let lastEmitWasAdd = false;
  for (const hunk of op.hunks) {
    if (hunk.lines.length === 0) throw new CodexPatchError(`hunk vacio en ${op.path}`);
    const start = locate(lines, origIdx, hunk, op.path);
    for (const line of lines.slice(origIdx, start)) {
      out.push(line);
      lastEmitWasAdd = false;
    }
    let i = start;
    for (const item of hunk.lines) {
      if (item.kind === "add") {
        out.push(item.text);
        lastEmitWasAdd = true;
        continue;
      }
      if (i >= lines.length || lines[i] !== item.text) {
        throw new CodexPatchError(`contexto no coincide en ${op.path} (linea ${i + 1})`);
      }
      if (item.kind === "ctx") {
        out.push(lines[i]!);
        lastEmitWasAdd = false;
      }
      i++;
    }
    origIdx = i;
  }
  for (const line of lines.slice(origIdx)) {
    out.push(line);
    lastEmitWasAdd = false;
  }
  if (out.length === 0) return "";
  // Nueva linea final: se conserva la del original; una adicion como ultima
  // linea la define con newline (regla deterministica, documentada).
  return out.join("\n") + (finalNewline || lastEmitWasAdd ? "\n" : "");
}

function resolvePatchWithin(root: string, candidate: string): string | null {
  const resolved = candidate ? resolve(root, candidate) : resolve(root);
  const rel = process.platform === "win32"
    ? relative(root.toLowerCase(), resolved.toLowerCase())
    : relative(root, resolved);
  if (rel === "") return resolved;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return resolved;
}

function applyCodexPatchWindows(cwd: string, ops: FileOp[]): string[] {
  const root = realpathSync(cwd);
  const createdDirs: string[] = [];
  const scratch = new Set<string>();
  const published: Array<{ target: string; backup?: string; add: boolean }> = [];
  let retainBackups = false;
  const normalized = ops.map((op) => {
    const abs = resolvePatchWithin(root, op.path);
    if (!abs || abs === root) throw new CodexPatchError(`path fuera del workspace: ${op.path}`);
    const rel = relative(root, abs);
    const parts = rel.split(/[\\/]/);
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      try {
        const info = lstatSync(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new CodexPatchError(`padre no es directorio seguro: ${current}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        break;
      }
    }
    return { op, abs, rel, parts };
  });
  const names = new Set<string>();
  for (const item of normalized) {
    const key = item.rel.toLowerCase();
    if (names.has(key)) throw new CodexPatchError(`ruta repetida en el patch: ${item.op.path}`);
    names.add(key);
  }
  for (const item of normalized) {
    for (let i = 1; i < item.parts.length; i++) {
      if (names.has(item.parts.slice(0, i).join(sep).toLowerCase())) {
        throw new CodexPatchError(`archivo usado como directorio en el patch: ${item.rel}`);
      }
    }
  }

  const planned = normalized.map((item) => {
    let original: Buffer | undefined;
    let mode = 0o644;
    let identity: { dev: number; ino: number } | undefined;
    try {
      const info = lstatSync(item.abs);
      if (item.op.op === "add") throw new CodexPatchError(`el archivo ya existe: ${item.op.path}`);
      if (!info.isFile() || info.isSymbolicLink()) throw new CodexPatchError(`archivo no regular o symlink: ${item.op.path}`);
      const fd = openSync(item.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = fstatSync(fd);
        if (!actual.isFile()) throw new CodexPatchError(`archivo no regular: ${item.op.path}`);
        original = readFileSync(fd);
        mode = actual.mode & 0o777;
        identity = { dev: actual.dev, ino: actual.ino };
      } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (item.op.op !== "add" && original === undefined) throw new CodexPatchError(`el archivo no existe: ${item.op.path}`);
    const content = item.op.op === "add" ? item.op.lines.join("\n") + (item.op.lines.length ? "\n" : "")
      : item.op.op === "update" ? applyUpdate(original!.toString("utf8"), item.op) : undefined;
    return { ...item, original, mode, identity, content, staged: undefined as string | undefined, backup: undefined as string | undefined };
  });

  try {
    for (const item of planned) {
      let current = root;
      for (const part of item.parts.slice(0, -1)) {
        current = join(current, part);
        try {
          const info = lstatSync(current);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new CodexPatchError(`padre no es directorio seguro: ${current}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          mkdirSync(current);
          createdDirs.push(current);
        }
      }
      if (item.original !== undefined) {
        const fd = openSync(item.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = fstatSync(fd);
          if (info.dev !== item.identity!.dev || info.ino !== item.identity!.ino || !readFileSync(fd).equals(item.original)) {
            throw new CodexPatchError(`archivo cambio durante el patch: ${item.rel}`);
          }
        } finally { closeSync(fd); }
      } else {
        try { lstatSync(item.abs); throw new CodexPatchError(`el archivo ya existe: ${item.rel}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (item.content !== undefined) {
        item.staged = `${item.abs}.isymcp-stage-${randomUUID()}`;
        const fd = openSync(item.staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), item.mode);
        scratch.add(item.staged);
        try { writeFileSync(fd, item.content); } finally { closeSync(fd); }
      }
    }
    for (const item of planned) {
      if (item.op.op === "add") {
        linkSync(item.staged!, item.abs);
        published.push({ target: item.abs, add: true });
      } else {
        item.backup = `${item.abs}.isymcp-backup-${randomUUID()}`;
        renameSync(item.abs, item.backup);
        scratch.add(item.backup);
        published.push({ target: item.abs, backup: item.backup, add: false });
        if (item.staged) { renameSync(item.staged, item.abs); scratch.delete(item.staged); }
      }
    }
    return normalized.map((item) => item.rel);
  } catch (error) {
    const failures: string[] = [];
    for (const item of published.reverse()) {
      try {
        if (item.add) unlinkSync(item.target);
        else {
          try { unlinkSync(item.target); } catch (removeError) {
            if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") throw removeError;
          }
          renameSync(item.backup!, item.target);
          scratch.delete(item.backup!);
        }
      } catch {
        const recoverable = item.backup ?? item.target;
        try { failures.push(realpathSync(recoverable)); } catch { failures.push(recoverable); }
      }
    }
    retainBackups = failures.length > 0;
    throw new CodexPatchError(`${error instanceof Error ? error.message : String(error)}${failures.length ? `; rollback incompleto, backups conservados: ${failures.join(", ")}` : ""}`);
  } finally {
    for (const path of scratch) {
      if (retainBackups && path.includes(".isymcp-backup-")) continue;
      try { unlinkSync(path); } catch { /* preserve unrelated paths */ }
    }
    for (const path of createdDirs.reverse()) { try { rmdirSync(path); } catch { /* keep non-empty successful parents */ } }
  }
}

/**
 * Validate all operations, stage every write and backup, then publish.
 * Linux uses directory descriptors and O_NOFOLLOW; Windows runs this helper
 * inside the native Codex sandbox and rejects reparse-point parents.
 * Publication is atomic per file; a commit error rolls back earlier files.
 * This is not a multi-file filesystem transaction for concurrent observers.
 */
export function applyCodexPatch(cwd: string, patch: string): string[] {
  const ops = parse(patch);
  if (process.platform === "win32") return applyCodexPatchWindows(cwd, ops);
  if (process.platform !== "linux") throw new CodexPatchError("native patch confinement requires Linux directory descriptors or the Windows sandbox");
  const root = realpathSync(cwd);
  const dirs = new Map<string, number>();
  const createdDirs: string[] = [];
  const scratch = new Set<string>();
  const published: Array<{ target: string; backup?: string; add: boolean }> = [];
  let retainBackups = false;
  try {
    dirs.set("", openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const normalized = ops.map(op => {
      const abs = resolvePatchWithin(root, op.path);
      if (!abs || abs === root) throw new CodexPatchError(`path fuera del workspace: ${op.path}`);
      return { op, path: relative(root, abs), parts: relative(root, abs).split("/") };
    });
    const names = new Set<string>();
    for (const p of normalized) {
      if (names.has(p.path)) throw new CodexPatchError(`ruta repetida en el patch: ${p.op.path}`);
      names.add(p.path);
    }
    for (const p of normalized) {
      for (let i = 1; i < p.parts.length; i++) if (names.has(p.parts.slice(0, i).join("/")))
        throw new CodexPatchError(`archivo usado como directorio en el patch: ${p.path}`);
    }
    const parent = (parts: string[], create: boolean): string | null => {
      let key = "";
      let fd = dirs.get("")!;
      for (const part of parts.slice(0, -1)) {
        const next = key ? `${key}/${part}` : part;
        if (!dirs.has(next)) {
          const anchored = `/proc/self/fd/${fd}/${part}`;
          try { dirs.set(next, openSync(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)); }
          catch (error: any) {
            if (error.code !== "ENOENT") throw new CodexPatchError(`padre no es directorio seguro: ${next}`);
            if (!create) return null;
            mkdirSync(anchored);
            createdDirs.push(anchored);
            dirs.set(next, openSync(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
          }
        }
        key = next; fd = dirs.get(key)!;
      }
      return `/proc/self/fd/${fd}/${parts.at(-1)!}`;
    };
    const planned = normalized.map(p => {
      const target = parent(p.parts, false);
      let original: Buffer | undefined;
      let mode = 0o644;
      let identity: { dev: number; ino: number } | undefined;
      if (target) {
        try {
          const info = lstatSync(target);
          if (p.op.op === "add") throw new CodexPatchError(`el archivo ya existe: ${p.op.path}`);
          if (!info.isFile() || info.isSymbolicLink()) throw new CodexPatchError(`archivo no regular o symlink: ${p.op.path}`);
          const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const actual = fstatSync(fd);
            if (!actual.isFile()) throw new CodexPatchError(`archivo no regular: ${p.op.path}`);
            original = readFileSync(fd); mode = actual.mode & 0o777;
            identity = { dev: actual.dev, ino: actual.ino };
          } finally { closeSync(fd); }
        } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      }
      if (p.op.op !== "add" && original === undefined) throw new CodexPatchError(`el archivo no existe: ${p.op.path}`);
      const content = p.op.op === "add" ? p.op.lines.join("\n") + (p.op.lines.length ? "\n" : "")
        : p.op.op === "update" ? applyUpdate(original!.toString("utf8"), p.op) : undefined;
      return { ...p, original, mode, identity, content, target: "", staged: undefined as string | undefined, backup: undefined as string | undefined };
    });
    // All syntax, paths and hunks are valid before creating directories/files.
    for (const p of planned) {
      p.target = parent(p.parts, true)!;
      if (p.original !== undefined) {
        p.backup = `${p.target}.isymcp-backup-${randomUUID()}`;
        linkSync(p.target, p.backup); scratch.add(p.backup);
      }
      if (p.content !== undefined) {
        p.staged = `${p.target}.isymcp-stage-${randomUUID()}`;
        const fd = openSync(p.staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, p.mode);
        scratch.add(p.staged);
        try { writeFileSync(fd, p.content); fchmodSync(fd, p.mode); } finally { closeSync(fd); }
      }
    }
    // Reject a changed source before publishing any part of this patch.
    for (const p of planned) {
      if (p.original !== undefined) {
        const fd = openSync(p.target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = fstatSync(fd);
          if (info.dev !== p.identity!.dev || info.ino !== p.identity!.ino || !readFileSync(fd).equals(p.original))
            throw new CodexPatchError(`archivo cambio durante el patch: ${p.path}`);
        } finally { closeSync(fd); }
      } else {
        try { lstatSync(p.target); throw new CodexPatchError(`el archivo ya existe: ${p.path}`); }
        catch (error: any) { if (error.code !== "ENOENT") throw error; }
      }
    }
    for (const p of planned) {
      if (p.op.op === "add") linkSync(p.staged!, p.target); // no-overwrite publication
      else if (p.staged) { renameSync(p.staged, p.target); scratch.delete(p.staged); }
      else unlinkSync(p.target);
      published.push({ target: p.target, backup: p.backup, add: p.op.op === "add" });
    }
    return normalized.map(p => p.path);
  } catch (error) {
    const failures: string[] = [];
    for (const p of published.reverse()) {
      try {
        if (p.add) unlinkSync(p.target);
        else { renameSync(p.backup!, p.target); scratch.delete(p.backup!); }
      } catch {
        const recoverable = p.backup ?? p.target;
        // Descriptors close in finally: report the persistent path for recovery.
        try { failures.push(realpathSync(recoverable)); }
        catch { failures.push(recoverable); }
      }
    }
    retainBackups = failures.length > 0;
    throw new CodexPatchError(`${error instanceof Error ? error.message : String(error)}${failures.length ? `; rollback incompleto, backups conservados: ${failures.join(", ")}` : ""}`);
  } finally {
    for (const path of scratch) {
      if (retainBackups && path.includes(".isymcp-backup-")) continue;
      try { unlinkSync(path); } catch { /* preserve unrelated paths */ }
    }
    for (const path of createdDirs.reverse()) { try { rmdirSync(path); } catch { /* keep non-empty successful parents */ } }
    for (const fd of [...dirs.values()].reverse()) { try { closeSync(fd); } catch { /* descriptor already closed */ } }
  }
}
