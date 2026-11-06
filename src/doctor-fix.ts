// doctor-fix.ts — M7 (opcional): remedios automaticos minimos y con whitelist.
//
// Nada fuera de FIX_ACTIONS puede ejecutarse: applyFix lanza con un error claro.
// Sin `--apply` el CLI solo muestra el plan (dry-run). No borra ni descarga.
import { mkdirSync } from "node:fs";

export interface FixContext {
  mediaHome: string;
  mkdir?: (path: string) => void;
}

export interface FixResult {
  ok: boolean;
  detail: string;
}

export interface FixAction {
  id: string;
  describe: string;
  run: (context: FixContext) => FixResult;
}

export const FIX_ACTIONS: Record<string, FixAction> = {
  "media-home": {
    id: "media-home",
    describe: "Crea el directorio de estado de medios si no existe (no borra nada)",
    run: ({ mediaHome, mkdir = (path) => mkdirSync(path, { recursive: true }) }) => {
      mkdir(mediaHome);
      return { ok: true, detail: `directorio de medios listo: ${mediaHome}` };
    },
  },
};

export function fixActionFor(id: string): FixAction | undefined {
  return id in FIX_ACTIONS ? FIX_ACTIONS[id] : undefined;
}

export function listFixActions(): string[] {
  return Object.keys(FIX_ACTIONS);
}

/** Devuelve el plan sin ejecutar nada. Lanza si la accion no esta permitida. */
export function planFix(id: string): string {
  const action = fixActionFor(id);
  if (!action) throw new Error(`accion no permitida: ${id}; permitidas: ${listFixActions().join(", ")}`);
  return action.describe;
}

/** Ejecuta una accion whitelisted. Lanza si la accion no esta permitida. */
export function applyFix(id: string, context: FixContext): FixResult {
  const action = fixActionFor(id);
  if (!action) throw new Error(`accion no permitida: ${id}; permitidas: ${listFixActions().join(", ")}`);
  return action.run(context);
}
