// src/cli/module.ts — Núcleo de la CLI: cada comando es un módulo que se registra aquí.
//
// isymcp.ts era una sola cadena `if (cmd === ...) else if ...` de ~40 comandos. Los comandos migrados
// viven en src/cli/commands/<nombre>.ts y exportan un CliModule; el router los busca por nombre.
import { allowModule } from "./commands/allow";
import { harnessModule } from "./commands/harness";
import { tuiModule } from "./commands/tui";

export interface CliContext {
  /** Raíz del repo (para rutas como backups/). */
  root: string;
  /** Ayuda global de `isymcp` (para subcomandos desconocidos). */
  help: () => void;
}

export interface CliModule {
  /** Nombres con los que se invoca (`isymcp <nombre> ...`). */
  names: string[];
  run(sub: string | undefined, rest: string[], ctx: CliContext): Promise<void>;
}

export const CLI_MODULES: CliModule[] = [allowModule, harnessModule, tuiModule];

export function findCliModule(cmd: string | undefined): CliModule | null {
  if (!cmd) return null;
  return CLI_MODULES.find((m) => m.names.includes(cmd)) ?? null;
}
