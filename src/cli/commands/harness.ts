// src/cli/commands/harness.ts — `isymcp harness list|install|uninstall` (MCP de ISyMCP en otras TUIs).
import type { CliModule } from "../module";
import { ask, confirm } from "../args";

// harness list|install|uninstall — MCP de ISyMCP en otras CLIs/TUIs.
//   --server chatgpt (defecto): isymcp-chatgpt (chatgpt_ask)
//   --server gateway: isymcp (gateway completo: tool isymcp, monitor, consolas, media, github)
//   --server all: ambos
// Sin --apply NUNCA escribe: imprime el comando exacto que correria.
export async function harnessCommand(sub: string, rest: string[]): Promise<void> {
  const { apply, CATALOG, detect, plan, serverName } = await import("../../harness");
  const json = rest.includes("--json");
  const serverArg = (() => {
    const i = rest.indexOf("--server");
    const v = i >= 0 ? rest[i + 1] : rest.find((a) => a.startsWith("--server="))?.slice(9);
    return (v ?? "chatgpt").toLowerCase();
  })();
  if (!["chatgpt", "gateway", "all"].includes(serverArg)) throw new Error("--server debe ser chatgpt, gateway o all");
  const kinds = (serverArg === "all" ? ["chatgpt", "gateway"] : [serverArg]) as Array<"chatgpt" | "gateway">;
  const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--server");
  if (sub === "list") {
    const byKind = await Promise.all(kinds.map((k) => detect(undefined, k)));
    if (json) { console.log(JSON.stringify(Object.fromEntries(kinds.map((k, i) => [k, byKind[i]])), null, 2)); return; }
    const first = byKind[0]!;
    for (let r = 0; r < first.length; r++) {
      const s = first[r]!;
      const cols = kinds.map((k, i) => {
        const x = byKind[i]![r]!;
        const n = serverName(k);
        return !x.present ? "" : !x.supported ? `detectado · ${x.pending}` : x.installed === true ? `${n} ✓` : x.installed === false ? `sin ${n}` : `${n}: estado desconocido`;
      });
      console.log(`  ${s.present ? "●" : "·"} ${s.id.padEnd(9)} ${s.present ? cols.join("  ·  ") : "no instalado"}`);
    }
    return;
  }
  if (sub !== "install" && sub !== "uninstall") throw new Error("uso: isymcp harness list | install|uninstall <ids|--all> [--server chatgpt|gateway|all] [--apply]");
  for (const kind of kinds) {
    const ids = rest.includes("--all")
      ? (await detect(undefined, kind)).filter((s) => s.present && s.supported).map((s) => s.id)
      : positional;
    if (ids.length === 0) throw new Error(`indica harnesses (${CATALOG.filter((d) => d.strategy).map((d) => d.id).join(", ")}) o --all`);
    if (kinds.length > 1) console.log(`── ${serverName(kind)} ──`);
    if (!rest.includes("--apply")) {
      console.log(`PLAN (${sub} ${serverName(kind)}) — no se escribio nada. Repite con --apply para ejecutarlo:`);
      for (const step of await plan(sub, ids, kind)) console.log(`  ${step.id.padEnd(9)} ${step.argv ? step.argv.join(" ") : `(nada) ${step.reason}`}`);
      continue;
    }
    const results = await apply(sub, ids, true, kind);
    if (json) { console.log(JSON.stringify(results, null, 2)); continue; }
    for (const r of results) {
      const mark = !r.ran ? "–" : r.ok ? "✓" : "✗";
      console.log(`  ${mark} ${r.id.padEnd(9)} ${r.ran ? `verificado=${r.verified}` : ""} ${r.detail}`);
    }
    if (results.some((r) => r.ran && !r.ok)) process.exitCode = 1;
  }
}


export async function harnessInteractive(sub: "install" | "uninstall"): Promise<void> {
  const { detect } = await import("../../harness");
  const usable = (await detect()).filter((s) => s.present && s.supported);
  if (usable.length === 0) { console.log("no hay harnesses instalables detectados"); return; }
  console.log(`detectados: ${usable.map((s) => `${s.id}${s.installed === true ? " ✓" : ""}`).join(", ")}`);
  const raw = await ask("¿cuales? (separados por coma, o 'todos'): ");
  if (!raw) return;
  const ids = /^(todos|all)$/i.test(raw) ? ["--all"] : raw.split(/[\s,]+/).filter(Boolean);
  await harnessCommand(sub, ids);
  if (await confirm("¿Ejecutar este plan?")) await harnessCommand(sub, [...ids, "--apply"]);
  else console.log("nada escrito");
}


export const harnessModule: CliModule = {
  names: ["harness"],
  run: (sub, rest) => harnessCommand(sub ?? "list", rest),
};
