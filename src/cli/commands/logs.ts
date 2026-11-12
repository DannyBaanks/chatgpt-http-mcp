// src/cli/commands/logs.ts — `isymcp logs`.
import { flag } from "../../cli/args";
import { defaultExportPath, exportLines, formatLine, parseBound, readAll, selectLines } from "../../logs";
import type { CliModule } from "../module";

export function logs(args: string[]): void {
  const since = flag("--since", args);
  const until = flag("--until", args);
  const out = flag("--out", args);
  const lastRaw = flag("--last", args);
  const exporting = args[0] === "export" || args.includes("--all");
  const sinceMs = since ? parseBound(since) : undefined;
  const untilMs = until ? parseBound(until) : undefined;
  const last = exporting ? undefined : Number(lastRaw ?? "50");
  if (last !== undefined && (!Number.isInteger(last) || last < 0)) {
    throw new Error(`--last invalido: ${lastRaw}`);
  }
  const selected = selectLines(readAll(), { last, sinceMs, untilMs });
  if (!exporting) {
    if (selected.length === 0) {
      console.log("sin lineas (el server aun no escribio log, o el filtro no matchea)");
      return;
    }
    for (const line of selected) console.log(formatLine(line));
    console.log(`--- ${selected.length} lineas ---`);
    return;
  }
  const path = out ?? defaultExportPath();
  const saved = exportLines(selected, path);
  console.log(`guardado: ${saved.path}`);
  console.log(`lineas: ${saved.count}`);
}

export const logsModule: CliModule = {
  names: ["logs"],
  async run(sub, rest) {
    logs([sub, ...rest].filter((part): part is string => Boolean(part)));
  },
};
