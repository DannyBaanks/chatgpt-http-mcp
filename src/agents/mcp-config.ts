// src/agents/mcp-config.ts — Formatos de config MCP de las TUIs y escritura segura de JSON.
//
// Movido sin cambios desde src/harness.ts (unificación del catálogo, 2026-11-12):
//   cli   — la herramienta trae su propio `mcp add/remove`: ELLA escribe su formato (lo más seguro).
//   json  — se edita su archivo real; un JSON que no se puede leer no se toca.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CliStrategy {
  kind: "cli";
  add: (exe: string, launcher: string, name: string) => string[];
  remove: (exe: string, name: string) => string[];
  /** Comando cuya salida contiene el nombre si esta instalado. */
  list: (exe: string, name: string) => string[];
}

export interface JsonStrategy {
  kind: "json";
  configPath: () => string;
  readInstalled: (path: string, names: string[]) => boolean;
  add: (path: string, launcher: string, name: string) => void;
  remove: (path: string, names: string[]) => void;
}

export type Strategy = CliStrategy | JsonStrategy;

export const cli = (s: Omit<CliStrategy, "kind">): CliStrategy => ({ kind: "cli", ...s });

export function readJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}
/**
 * El campo `key` como objeto plano: lo crea si no existe; si existe y NO es un objeto (p. ej. un arreglo),
 * lanza en vez de escribir (un arreglo perdería en silencio lo agregado y pisaría datos ajenos).
 */
export function objectField(data: Record<string, any>, key: string, path: string): Record<string, any> {
  const value = data[key];
  if (value === undefined || value === null) return (data[key] = {});
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`"${key}" no es un objeto JSON en ${path}: no se modifica`);
  }
  return value;
}

/** Escribe solo si el archivo existente se pudo leer: nunca se pisa un JSON que no se entendió. */
export function editJson(path: string, edit: (data: Record<string, any>) => boolean): void {
  let data: Record<string, any> = {};
  if (existsSync(path)) {
    const parsed = readJson(path);
    if (!parsed) throw new Error(`no se pudo leer ${path} como JSON: no se modifica`);
    data = parsed;
  } else {
    mkdirSync(join(path, ".."), { recursive: true });
  }
  if (edit(data)) writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/** Formato `mcpServers` (Cursor, agy, Kimi Code). */
export function mcpServersStrategy(configPath: () => string, entry: (launcher: string) => Record<string, unknown>): JsonStrategy {
  return {
    kind: "json",
    configPath,
    readInstalled: (path, names) => {
      const data = readJson(path);
      return names.some((n) => Boolean(data?.mcpServers?.[n]));
    },
    add: (path, launcher, name) => editJson(path, (data) => {
      objectField(data, "mcpServers", path)[name] = entry(launcher);
      return true;
    }),
    remove: (path, names) => {
      if (!existsSync(path)) return;
      editJson(path, (data) => {
        const hits = names.filter((n) => data?.mcpServers?.[n]);
        for (const n of hits) delete data.mcpServers[n];
        return hits.length > 0;
      });
    },
  };
}

/**
 * Formato opencode (también openisy). Se escribe la forma `mcp.<nombre>`: v2 la normaliza
 * (verificado 2026-11-11: el servicio de opencode 2.2.5 y el de openisy lanzan el servidor).
 * Se lee también la forma nativa v2 `mcp.servers.<nombre>`.
 */
export function opencodeStrategy(configPath: () => string): JsonStrategy {
  return {
    kind: "json",
    configPath,
    readInstalled: (path, names) => {
      const data = readJson(path);
      return names.some((n) => Boolean(data?.mcp?.[n] || data?.mcp?.servers?.[n]));
    },
    add: (path, launcher, name) => editJson(path, (data) => {
      objectField(data, "mcp", path)[name] = { type: "local", command: [launcher], enabled: true };
      return true;
    }),
    remove: (path, names) => {
      if (!existsSync(path)) return;
      editJson(path, (data) => {
        let changed = false;
        for (const n of names) {
          if (data?.mcp?.[n]) { delete data.mcp[n]; changed = true; }
          if (data?.mcp?.servers?.[n]) { delete data.mcp.servers[n]; changed = true; }
        }
        return changed;
      });
    },
  };
}

/** Crush: `mcp.<nombre> = { type: "stdio", command }` en ~/.config/crush/crush.json. */
export function crushStrategy(configPath: () => string): JsonStrategy {
  return {
  kind: "json",
  configPath,
  readInstalled: (path, names) => {
    const data = readJson(path);
    return names.some((n) => Boolean(data?.mcp?.[n]));
  },
  add: (path, launcher, name) => editJson(path, (data) => {
    objectField(data, "mcp", path)[name] = { type: "stdio", command: launcher };
    return true;
  }),
  remove: (path, names) => {
    if (!existsSync(path)) return;
    editJson(path, (data) => {
      const hits = names.filter((n) => data?.mcp?.[n]);
      for (const n of hits) delete data.mcp[n];
      return hits.length > 0;
    });
  },
};
}
