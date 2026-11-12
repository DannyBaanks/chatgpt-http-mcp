// src/cli/commands/tui.ts — `isymcp tui list|install|agents|spawn`.
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliModule } from "../module";
import { flag } from "../args";
import { harnessCommand } from "./harness";
import { detectTuis, installIntoAllTuis, installIntoTui } from "../../tui";

export const tuiModule: CliModule = {
  names: ["tui"],
  async run(sub, rest, ctx) {
    if (sub === "--help" || sub === "-h") {
      console.log(`
    isymcp tui — Gestión de integración MCP en entornos de agentes y TUIs

    USO:
    isymcp tui list                         Lista las herramientas/TUIs detectadas en el sistema
    isymcp tui install [tui|--all]          Muestra el plan de configuración MCP (dry-run por defecto)
    isymcp tui install [tui|--all] --apply  Aplica los cambios en las configs con respaldo automático
    isymcp tui install [tui|--all] --restore Restaura la configuración previa desde el último backup
    isymcp tui spawn "<instrucción>" [--agent <id>] [--dry-run]  Abre una consola de agente (agy por defecto)
    isymcp tui agents                       Agentes que se pueden lanzar y cómo reciben tareas

    EJEMPLOS:
    isymcp tui install openisy --apply      # Configura OpenCode / OpenISy
    isymcp tui install agy --apply          # Configura Antigravity CLI / Gemini
    isymcp tui install claude --apply       # Configura Claude Desktop / Code
    isymcp tui install --all --apply        # Aplica en todas las TUIs presentes en el host
    isymcp tui spawn "Hola agy"             # Lanza consola visible de Antigravity
    isymcp tui spawn "Revisa PITON" --agent openisy   # Misma coordinación con OpenISy
    `);
      process.exit(0);
    }
    const baseUrl = process.env.ISYMCP_TUI_BASE_URL?.trim() || "http://127.0.0.1:8791";
    const configPath = flag("--config", rest) ?? join(homedir(), ".config", "opencode", "opencode.json");
    if (!sub || sub === "list") {
      for (const tui of detectTuis(homedir())) {
        console.log(`${tui.present ? "presente " : "ausente  "}${tui.installable ? "[instalable]" : "            "} ${tui.id} (${tui.label}) ${
          tui.bin ?? tui.configDir}`);
      }
    } else if (sub === "install") {
      const targetConfigPath = flag("--config", rest);
      const positional: string[] = [];
      const flagsWithValues = new Set(["--config", "--tui", "--base-url", "--mcp-main"]);
      for (let i = 0; i < rest.length; i++) {
        if (flagsWithValues.has(rest[i])) {
          i++; // saltar el valor asociado
          continue;
        }
        if (!rest[i].startsWith("-")) {
          positional.push(rest[i]);
        }
      }

      const isAll = rest.includes("--all") || flag("--tui", rest) === "all" || positional.includes("all");
      const which = flag("--tui", rest) ?? (positional[0] ? positional[0] : (isAll ? "all" : (targetConfigPath ? "opencode" : "all")));
      const dryRun = !rest.includes("--apply");
      const restore = rest.includes("--restore");
      const backupsDir = join(ctx.root, "backups", "tui");

      if (isAll || which === "all") {
        const results = installIntoAllTuis({
          backupsDir,
          baseUrl,
          dryRun,
          restore,
          onlyPresent: !rest.includes("--force-all"),
        });
        let hasErrors = false;
        const viaHarness: string[] = [];
        for (const { tui, result, error } of results) {
          if (error) {
            hasErrors = true;
            console.error(`✗ ${tui.id} (${tui.label}): ${error}`);
          } else if (result) {
            // Provider de modelos Web (solo opencode/openisy); el MCP de todas va por harness.
            if (result.models > 0 || result.action === "restore") {
              console.log(`${result.action === "dry-run" ? "[dry-run]" : "✓"} ${tui.id} (${tui.label}): provider ${result.configPath} modelos=${result.models} ${result.backupPath ? `(backup: ${result.backupPath})` : ""}`);
            }
            if (result.harness) viaHarness.push(tui.id);
          }
        }
        if (viaHarness.length > 0 && !restore) {
          console.log(`\nMCP (gateway isymcp) por harness: ${viaHarness.join(", ")}`);
          await harnessCommand("install", [...viaHarness, "--server", "gateway", ...(dryRun ? [] : ["--apply"])]);
        }
        if (hasErrors) process.exitCode = 1;
        if (dryRun) console.log("\nModo dry-run: ningún archivo modificado. Usa '--apply' para escribir los cambios con backup.");
      } else {
        try {
          const result = installIntoTui({
            tuiId: which,
            configPath: targetConfigPath,
            backupsDir,
            baseUrl,
            dryRun,
            restore,
          });
          const { findAgent } = await import("../../agents/catalog");
          const id = findAgent(which)?.id ?? which;
          const providerTouched = result.models > 0 || result.action === "restore";
          if (providerTouched) {
            console.log(`${result.action === "dry-run" ? "[dry-run]" : "✓"} ${id}: provider ${result.configPath} modelos=${result.models}${result.backupPath ? ` backup=${result.backupPath}` : ""}`);
          }
          if (result.harness && restore && !providerTouched) {
            throw new Error(`el MCP de ${id} lo instala harness: usa isymcp harness uninstall ${id} --server gateway --apply`);
          }
          if (result.harness && !restore) {
            console.log(`MCP (gateway isymcp) por harness:`);
            await harnessCommand("install", [id, "--server", "gateway", ...(dryRun ? [] : ["--apply"])]);
          }
          if (dryRun) console.log("nada escrito (usa --apply para escribir)");
        } catch (err: any) {
          console.error(`Error instalando en ${which}: ${err.message}`);
          process.exitCode = 1;
        }
      }
    } else if (sub === "agents") {
      const { AGENT_TUIS, findAgentBinary } = await import("../../agent-tuis");
      const rows = AGENT_TUIS.map((a) => ({ agent: a.id, label: a.label, bin: findAgentBinary(a), prompt_via: a.promptVia, listener: a.listener }));
      if (rest.includes("--json")) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) {
        console.log(`  ${r.bin ? "●" : "·"} ${r.agent.padEnd(9)} ${r.bin ? r.bin : "no instalado"}  · prompt ${r.prompt_via} · tareas ${r.listener}`);
      }
    } else if (sub === "spawn") {
      const flagsWithVal = new Set(["--cwd", "--title", "--mode", "--terminal", "--agent"]);
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (flagsWithVal.has(rest[i])) {
          i++;
          continue;
        }
        if (!rest[i].startsWith("-")) positionals.push(rest[i]);
      }
      const agent = flag("--agent", rest) || "agy";
      const prompt = positionals.join(" ") || `Hola ${agent}`;
      const cwd = flag("--cwd", rest);
      const title = flag("--title", rest);
      const mode = (flag("--mode", rest) as any) || "auto";
      const terminalPreference = flag("--terminal", rest) as any;
      const dryRun = rest.includes("--dry-run");
      const { spawnAgentTui } = await import("../../tui-launcher");
      const res = await spawnAgentTui({ agent, prompt, cwd, title, mode, terminalPreference, dryRun });
      if (dryRun) console.log(JSON.stringify({ ...res, command: res.command.map((a) => (a.length > 160 ? `${a.slice(0, 157)}...` : a)) }, null, 2));
      console.log(res.ok ? `✓ ${res.message}` : `✗ Error: ${res.error || res.message}`);
      process.exitCode = res.ok ? 0 : 1;
    } else {
      ctx.help();
      process.exit(2);
    }
  },
};
