// src/hive/guard.ts — Guarda de escritura del Hive: la carpeta del hive es solo para coordinación.
// Portado de isyco-worlds/src/main/hiveGuard.ts (puro, sin fs ni Electron).
import { isAbsolute, relative, resolve } from "node:path";

/** Herramientas de escritura sobre archivos que el hook PreToolUse valida dentro del hive. */
export const GUARDED_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

export interface HiveWriteInput {
  tool: string;
  toolInput: unknown;
  cwd?: string;
  agentId: string;
  isGod: boolean;
  hiveRoot: string;
  caseInsensitive: boolean;
}

export function hiveWriteDecision(i: HiveWriteInput): { deny: boolean; reason?: string } {
  if (!GUARDED_TOOLS.has(i.tool)) return { deny: false };
  const target = targetPath(i.toolInput, i.cwd);
  if (!target) return { deny: false };

  const norm = (p: string): string => (i.caseInsensitive ? p.toLowerCase() : p);
  if (!isInside(norm(i.hiveRoot), norm(target))) return { deny: false };

  const rel = relative(norm(resolve(i.hiveRoot)), norm(target)).split(/[\\/]/).join("/");
  if (isPlumbing(rel, norm(i.agentId), i.isGod)) return { deny: false };

  return {
    deny: true,
    reason:
      "The hive folder is only for coordination: your own memory.md, inbox and outbox, and tasks.json" +
      (i.isGod ? " (plus board.md and spawn-requests/ for you)" : "") +
      ". To reach another agent, write a message into your outbox. Save documents and other work in your working folder instead.",
  };
}

function isPlumbing(rel: string, agentId: string, isGod: boolean): boolean {
  const own = `agents/${agentId}/`;
  if (rel === `${own}memory.md`) return true;
  if (rel.startsWith(`${own}outbox/`) || rel.startsWith(`${own}inbox/`)) return true;
  if (rel === "tasks.json") return true;
  if (isGod && (rel === "board.md" || rel.startsWith("spawn-requests/"))) return true;
  return false;
}

function targetPath(input: unknown, cwd: string | undefined): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as { file_path?: unknown; notebook_path?: unknown };
  const p =
    typeof o.file_path === "string"
      ? o.file_path
      : typeof o.notebook_path === "string"
        ? o.notebook_path
        : null;
  if (!p) return null;
  return isAbsolute(p) ? resolve(p) : cwd ? resolve(cwd, p) : null;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
