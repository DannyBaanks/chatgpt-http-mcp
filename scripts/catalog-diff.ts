#!/usr/bin/env bun
// catalog-diff.ts — M3: invariantes del catalogo clonado + diff contra la
// referencia cuando exista una captura real.
//
//   bun run scripts/catalog-diff.ts
//   bun run scripts/catalog-diff.ts --reference /ruta/reference-models.json
//
// Sin --reference la paridad viva queda NOT_DEMONSTRATED (requiere login M1);
// las invariantes se validan igual y el comando sale 0.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCapabilities } from "../src/config";
import { augmentCatalog, diffWebRows, routeEfforts, availableRoutes } from "../src/web-models";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const fixture = argValue("--fixture") ?? join(import.meta.dir, "..", "fixtures", "native-models.sample.json");
const caps = parseCapabilities(argValue("--caps"));
const native = JSON.parse(readFileSync(fixture, "utf8")) as unknown;
const ours = augmentCatalog(native, caps) as { models: Array<Record<string, unknown>> };

const webRows = ours.models.filter(
  (model) => typeof model.slug === "string" && (model.slug as string).startsWith("chatgpt-web/"),
);
const nativeRows = ours.models.length - webRows.length;

const problems: string[] = [];
const slugs = ours.models.map((model) => model.slug);
if (new Set(slugs).size !== slugs.length) problems.push("slugs duplicados");
for (const row of webRows) {
  const contextWindow = row.context_window as number;
  const autoCompact = row.auto_compact_token_limit as number;
  if (!(contextWindow > 0)) problems.push(`${row.slug}: context_window invalido`);
  if (!(autoCompact > 0) || autoCompact >= contextWindow) problems.push(`${row.slug}: auto_compact invalido`);
  const levels = row.supported_reasoning_levels as unknown[];
  if (!Array.isArray(levels) || levels.length === 0) problems.push(`${row.slug}: sin reasoning levels`);
  if (row.supported_in_api !== true) problems.push(`${row.slug}: supported_in_api != true`);
}

console.log(`caps: sol=${caps.solAvailable} extraHigh=${caps.extraHighAvailable === true} pro=${caps.proAvailable}`);
console.log(`routes: ${availableRoutes(caps).map((route) => route.slug).join(", ") || "(ninguna)"}`);
console.log(`native_rows=${nativeRows} web_rows=${webRows.length}`);
for (const route of availableRoutes(caps)) {
  console.log(`  ${route.slug} efforts=[${routeEfforts(route, caps).join(",")}]`);
}
if (problems.length) {
  console.error("INVARIANTES FALLIDAS:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("invariantes: OK");

const referencePath = argValue("--reference");
if (!referencePath) {
  console.log(
    "parity viva: NOT_DEMONSTRATED (se requiere login M1 y capturar GET /v1/models de la referencia)",
  );
  process.exit(0);
}
if (!existsSync(referencePath)) {
  console.error(`referencia no encontrada: ${referencePath}`);
  process.exit(1);
}
const reference = JSON.parse(readFileSync(referencePath, "utf8")) as unknown;
const diff = diffWebRows(ours, reference);
console.log(`diff: missing=[${diff.missing.join(",")}] extra=[${diff.extra.join(",")}]`);
process.exit(diff.ok ? 0 : 1);
