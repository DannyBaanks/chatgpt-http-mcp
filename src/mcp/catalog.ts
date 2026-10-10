// catalog.ts — fuente unica de las tools nativas del connector.
//
// Los inputSchema que main.ts registra y las capacidades que
// codex_tool_inventory reporta salen de AQUI: una sola definicion, cero
// deriva entre lo que se registra y lo que se anuncia.
//
// El inventario solo declara tools EJECUTABLES; en modo stub (token sin
// sesion) nada es ejecutable y el inventario lo dice en vez de fingir.
import { z } from "zod";
import { CODEX_TOOLS } from "./identity";

export type ToolName = (typeof CODEX_TOOLS)[number];

export const TOKEN_FIELD = z.string().min(20).max(256);

/**
 * Shapes zod por tool, con la clave de turno segun el contrato
 * (native: turn_token; safe: request_id). main.ts las registra tal cual.
 */
export function shapesFor(contract: "native" | "safe"): Record<ToolName, Record<string, z.ZodType>> {
  const token = { [contract === "safe" ? "request_id" : "turn_token"]: TOKEN_FIELD };
  return {
    codex_turn_start: { ...token },
    codex_exec: {
      ...token,
      command: z.array(z.string()),
      cwd: z.string().optional(),
      background: z.boolean().optional(),
      capture_ms: z.number().int().min(0).max(5000).optional(),
    },
    codex_write_stdin: {
      ...token,
      exec_id: z.string().min(1),
      data: z.string(),
      close_stdin: z.boolean().optional(),
      signal: z.enum(["TERM", "KILL"]).optional(),
      wait_ms: z.number().int().min(0).max(10_000).optional(),
    },
    codex_apply_patch: { ...token, patch: z.string() },
    codex_view_image: { ...token, path: z.string() },
    codex_tool_inventory: { ...token },
    codex_tool_call: {
      ...token,
      wire_name: z.string().min(1).max(1_000),
      arguments: z.record(z.string(), z.unknown()).optional(),
      input: z.string().max(5_000_000).optional(),
      call_id: z.string().min(8).max(128).optional(),
    },
    codex_turn_complete: { ...token, response: z.string() },
  };
}

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  codex_turn_start: "Inicia un turno Codex. Devuelve el turn_token para las demas tools.",
  codex_exec:
    "Ejecuta un comando en el runtime Codex (sandbox bwrap del workspace). background=true inicia un proceso persistente con stdin abierto y devuelve exec_id para codex_write_stdin; capture_ms (0-5000, 1500 por defecto) es la espera inicial de salida.",
  codex_write_stdin:
    "Escribe al stdin de un proceso vivo iniciado con codex_exec background=true. Devuelve la salida nueva desde la ultima lectura; close_stdin manda EOF; signal TERM/KILL termina el proceso; wait_ms (0-10000, 2000 por defecto) acota la espera de salida.",
  codex_apply_patch:
    "Aplica un patch al workspace en dos formatos equivalentes: nativo Codex (*** Begin Patch ... *** End Patch) o diff unificado (git diff). Requiere sesion writable; un patch invalido no toca el archivo.",
  codex_view_image: "Devuelve una imagen del workspace para inspeccion del modelo (png/jpg/jpeg/webp/gif, max 8MB).",
  codex_tool_inventory:
    "Lista las tools nativas ejecutables en la sesion: nombres exactos, descripciones, esquemas de argumentos y requisitos (turn_token, writable).",
  codex_tool_call:
    "Invoca una tool nativa exacta por wire_name (el de codex_tool_inventory o el alias corto: exec, apply_patch, view_image, write_stdin, tool_inventory) con la sesion autorizada del turno: valida los argumentos contra el esquema y reusa sandbox y workspace. call_id deduplica reintentos.",
  codex_turn_complete:
    "Envia la respuesta completa al turno conectado y lo cierra: mata los procesos en segundo plano de la sesion.",
};

export const TOOL_REQUIRES: Record<ToolName, { writable: boolean; notes?: string }> = {
  codex_turn_start: { writable: false },
  codex_exec: { writable: false, notes: "read-only ejecuta sin escribir; escribir exige sesion writable" },
  codex_write_stdin: { writable: false, notes: "el proceso hereda la politica de la sesion que lo creo" },
  codex_apply_patch: { writable: true, notes: "solo sesiones writable" },
  codex_view_image: { writable: false },
  codex_tool_inventory: { writable: false },
  codex_tool_call: { writable: false, notes: "hereda el requisito de la tool destino (apply_patch exige writable)" },
  codex_turn_complete: { writable: false },
};

/**
 * Aliases que codex_tool_call acepta: el nombre codex_* del inventario o el
 * nombre corto del harness (mismos nucleos que responses/tools.ts filtra:
 * exec|exec_command|shell|shell_command|write_stdin|apply_patch|view_image).
 * turn_start/turn_complete quedan fuera: el ciclo de vida es del llamador.
 */
export const WIRE_ALIASES: Record<string, ToolName> = {
  codex_exec: "codex_exec",
  exec: "codex_exec",
  exec_command: "codex_exec",
  shell: "codex_exec",
  shell_command: "codex_exec",
  codex_apply_patch: "codex_apply_patch",
  apply_patch: "codex_apply_patch",
  codex_view_image: "codex_view_image",
  view_image: "codex_view_image",
  codex_write_stdin: "codex_write_stdin",
  write_stdin: "codex_write_stdin",
  codex_tool_inventory: "codex_tool_inventory",
  tool_inventory: "codex_tool_inventory",
};

export interface ToolCapability {
  name: ToolName;
  description: string;
  arguments: Record<string, unknown>;
  requires: { turn_token: boolean; writable: boolean; notes?: string };
  status: "executable";
}

/** Capacidades del inventario: siempre reflejan las shapes registradas. */
export function capabilities(contract: "native" | "safe"): ToolCapability[] {
  const S = shapesFor(contract);
  return CODEX_TOOLS.map((name) => {
    let args: Record<string, unknown>;
    try {
      args = z.toJSONSchema(z.object(S[name])) as unknown as Record<string, unknown>;
    } catch {
      args = { note: "esquema no serializable" };
    }
    return {
      name,
      description: TOOL_DESCRIPTIONS[name],
      arguments: args,
      requires: { turn_token: true, ...TOOL_REQUIRES[name] },
      status: "executable" as const,
    };
  });
}
