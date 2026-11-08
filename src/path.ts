// src/path.ts — Utilidades seguras de resolución y confinamiento de rutas dentro de un sandbox/workspace.
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";

/**
 * Confinamiento léxico: resuelve `candidate` dentro de `root`.
 * Retorna la ruta absoluta resuelta si está confinada dentro de `root`, o `null` si intenta escapar (e.g. "../").
 */
export function resolveWithin(root: string, candidate: string): string | null {
  const resolved = candidate ? resolve(root, candidate) : resolve(root);
  const rel = relative(root, resolved);
  if (rel === "") return resolved;
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

/**
 * Confinamiento con verificación de enlaces simbólicos (symlinks).
 * Como resolveWithin, pero además sigue symlinks del path existente: un link
 * dentro del workspace que apunta hacia afuera se niega (incluyendo ancestros que aún no existan en disco).
 */
export function resolveWithinReal(root: string, candidate: string): string | null {
  const lexical = resolveWithin(root, candidate);
  if (!lexical) return null;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  let cur = lexical;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  let realAncestor: string;
  try {
    realAncestor = realpathSync(cur);
  } catch {
    return null;
  }
  return resolveWithin(realRoot, realAncestor) ? lexical : null;
}
