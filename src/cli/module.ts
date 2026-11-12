// src/cli/module.ts — Núcleo de la CLI: cada comando es un módulo que se registra aquí.
//
// isymcp.ts era una sola cadena `if (cmd === ...) else if ...` de ~40 comandos. Los comandos migrados
// viven en src/cli/commands/<nombre>.ts y exportan un CliModule; el router los busca por nombre.
import { allowModule, taintModule } from "./commands/allow";
import { harnessModule } from "./commands/harness";
import { tuiModule } from "./commands/tui";
import { askModule } from "./commands/chat";
import { canaryModule } from "./commands/canary";
import { codexModule, commandModule, conversationModule, modelsModule, sessionModule } from "./commands/codex";
import { doctorModule, healthModule, metricsModule, smokeModule, treeModule } from "./commands/diagnostics";
import { downModule, serverModule, tunnelModule, upModule } from "./commands/lifecycle";
import { logsModule } from "./commands/logs";
import {
  comfyModule, execModule, fuzzModule, githubModule, helpModule, mediaModule, nativeBrowserModule, panelModule, tableroModule, uiModule, versionModule,
} from "./commands/misc";
import { monitorModule, protocolModule } from "./commands/monitor";

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

export const CLI_MODULES: CliModule[] = [
  allowModule, taintModule, harnessModule, tuiModule,
  upModule, downModule, serverModule, tunnelModule,
  askModule, codexModule, conversationModule, modelsModule, commandModule, sessionModule,
  monitorModule, protocolModule,
  healthModule, metricsModule, smokeModule, doctorModule, treeModule, canaryModule, logsModule,
  panelModule, uiModule, execModule, fuzzModule, versionModule, helpModule,
  nativeBrowserModule, tableroModule, mediaModule, comfyModule, githubModule,
];

export function findCliModule(cmd: string | undefined): CliModule | null {
  if (!cmd) return null;
  return CLI_MODULES.find((m) => m.names.includes(cmd)) ?? null;
}
