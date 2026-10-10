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
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolveWithin } from "../codex-sessions";

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
function applyUpdate(abs: string, op: { path: string; hunks: Hunk[] }): string {
  const { lines, finalNewline } = splitLines(readFileSync(abs, "utf8"));
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

function atomicWrite(abs: string, content: string, mode: number): void {
  const tmp = `${abs}.isyco-tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, { mode });
    renameSync(tmp, abs);
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Aplica un patch formato Codex dentro de `cwd`. Fase 1 valida y calcula
 * todo el contenido nuevo; fase 2 escribe (tmp+rename por archivo). Ante
 * cualquier invalidacion lanza CodexPatchError SIN escribir nada.
 * Devuelve las rutas tocadas (relativas a cwd, sin repetir).
 */
export function applyCodexPatch(cwd: string, patch: string): string[] {
  const ops = parse(patch);
  const planned: Array<{ abs: string; write?: { content: string; mode: number }; delete?: boolean }> = [];
  for (const op of ops) {
    const abs = resolveWithin(cwd, op.path);
    if (!abs) throw new CodexPatchError(`path fuera del workspace: ${op.path}`);
    if (op.op === "add") {
      if (existsSync(abs)) throw new CodexPatchError(`el archivo ya existe: ${op.path}`);
      const content = op.lines.join("\n") + (op.lines.length > 0 ? "\n" : "");
      planned.push({ abs, write: { content, mode: 0o644 } });
    } else if (op.op === "delete") {
      if (!existsSync(abs)) throw new CodexPatchError(`el archivo no existe: ${op.path}`);
      planned.push({ abs, delete: true });
    } else {
      if (!existsSync(abs)) throw new CodexPatchError(`el archivo no existe: ${op.path}`);
      const content = applyUpdate(abs, op);
      planned.push({ abs, write: { content, mode: statSync(abs).mode & 0o777 } });
    }
  }
  for (const p of planned) {
    if (p.write) atomicWrite(p.abs, p.write.content, p.write.mode);
  }
  for (const p of planned) {
    if (p.delete) unlinkSync(p.abs);
  }
  return [...new Set(ops.map((o) => o.path))];
}
