// src/cli/commands/misc.ts — Comandos pequeños: version, help, panel/ui, exec, fuzz y los adaptadores de
// subsistemas que ya tienen su propia CLI (media, comfy, github, tablero, native-browser).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliModule } from "../module";
import { flag } from "../args";
import { ROOT } from "../root";
import { openPanel, PANEL_PORT, PANEL_URL, panelUp, startPanelDetached, stopPanel } from "../services";
import { startPanel } from "../../panel";
import { nativeBrowserCommand } from "../../visible/native-browser";

export const versionModule: CliModule = {
  names: ["version", "--version", "-v"],
  async run() {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    console.log(`isymcp v${pkg.version ?? "unknown"}`);
  },
};

export const helpModule: CliModule = {
  names: ["help", "--help", "-h"],
  async run(_sub, _rest, ctx) {
    ctx.help();
  },
};

export const uiModule: CliModule = {
  names: ["ui", "control-center"],
  async run() {
    await openPanel("#control-center");
  },
};

export const panelModule: CliModule = {
  names: ["panel"],
  async run(sub, rest, ctx) {
    if (sub === "control-center" || sub === "ui") {
      await openPanel("#control-center");
      return;
    }
    const argsAll = [sub, ...rest].filter((a): a is string => Boolean(a));
    if (sub === "run" || argsAll.includes("--foreground")) {
      // Primer plano (lo usa tambien el modo detached por debajo).
      const port = Number(flag("--port", argsAll) ?? PANEL_PORT);
      startPanel(port);
      console.log(`panel en http://127.0.0.1:${port} (Ctrl+C para cerrar)`);
    } else if (sub === "start") {
      if (!(await startPanelDetached())) process.exitCode = 1;
    } else if (sub === "stop") {
      stopPanel();
    } else if (sub === "status") {
      console.log(`panel ${(await panelUp()) ? "up" : "down"} ${PANEL_URL}`);
    } else if (!sub || sub === "open") {
      await openPanel();
    } else {
      ctx.help();
      process.exit(2);
    }
  },
};

export const execModule: CliModule = {
  names: ["exec", "sh"],
  async run(sub, rest) {
    if (!sub || sub === "--help" || sub === "-h") {
      console.log(`
isymcp exec — Ejecución directa de comandos en shell local con CWD persistente

USO:
  isymcp exec "<comando>" [--cwd <directorio>] [--timeout <ms>]

EJEMPLOS:
  isymcp exec "git status"
  isymcp exec "cd ~/Development && ls"
`);
      process.exit(0);
    }
    const { executeShellCommand } = await import("../../shell/executor");
    const targetCwd = flag("--cwd", rest);
    const timeoutMs = flag("--timeout", rest) ? Number(flag("--timeout", rest)) : undefined;
    const filtered = [sub, ...rest].filter((a, idx, arr) => {
      if (a === "--cwd" || a === "--timeout") return false;
      if (idx > 0 && (arr[idx - 1] === "--cwd" || arr[idx - 1] === "--timeout")) return false;
      return Boolean(a);
    });
    const fullCmd = filtered.join(" ");
    if (!fullCmd) {
      console.error('uso: isymcp exec "<comando>"');
      process.exit(1);
    }
    const res = await executeShellCommand({ command: fullCmd, cwd: targetCwd, timeoutMs });
    if (res.stdout) process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : `${res.stdout}\n`);
    if (res.stderr) process.stderr.write(res.stderr.endsWith("\n") ? res.stderr : `${res.stderr}\n`);
    process.exitCode = res.exit_code;
  },
};

export const fuzzModule: CliModule = {
  names: ["fuzz"],
  async run(sub, rest) {
    if (sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
      console.log(`
isymcp fuzz — Suite de pruebas de robustez y fuzzing adversarial

USO:
  isymcp fuzz [iteraciones]

DESCRIPCIÓN:
  Ejecuta pruebas sintácticas intensivas sobre el instalador de TUIs
  y el Universal Gateway de ISyMCP para certificar robustez ante entradas adversariales.

EJEMPLO:
  isymcp fuzz 50   # Ejecuta 50 iteraciones por suite (por defecto: 50)
`);
      process.exit(0);
    }
    const { runFullFuzzSuite } = await import("../../fuzzer");
    const itArg = [sub, ...rest].find((a) => a && !a.startsWith("--"));
    const iterations = itArg ? parseInt(itArg, 10) : 50;
    console.log(`Ejecutando suite de fuzzing ISyMCP (${isNaN(iterations) ? 50 : iterations} iteraciones por suite)...`);
    const report = await runFullFuzzSuite(isNaN(iterations) ? 50 : iterations);
    for (const r of report.reports) {
      const tag = r.crashes === 0 && r.failed === 0 ? "✓" : "✗";
      console.log(`${tag} ${r.name}: ${r.passed}/${r.iterations} pasaron, ${r.failed} fallaron, ${r.crashes} crashes (${r.duration_ms}ms)`);
      for (const a of r.anomalies) {
        console.log(`    ⚠ ${a}`);
      }
    }
    console.log(`\nResultado global: ${report.ok ? "PASS (cero crashes)" : "FAIL"} [${report.duration_ms}ms]`);
    if (!report.ok) process.exitCode = 1;
  },
};

export const nativeBrowserModule: CliModule = {
  names: ["native-browser"],
  async run(sub, rest) {
    process.exitCode = await nativeBrowserCommand(sub, rest);
  },
};

export const tableroModule: CliModule = {
  names: ["tablero"],
  async run(sub) {
    process.exitCode = (await import("../../tablero/cli")).tableroCommand(sub ?? "status");
  },
};

export const mediaModule: CliModule = {
  names: ["media"],
  async run(sub, rest) {
    try { await (await import("../../media/cli")).mediaCommand(sub, rest); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      const message = error instanceof Error ? error.message : String(error);
      console.error(code ? `✗ ${code}: ${message}` : `✗ ${message}`);
      process.exitCode = 1;
    }
  },
};

export const comfyModule: CliModule = {
  names: ["comfy"],
  async run(sub, rest) {
    try { await (await import("../../comfyui/cli")).comfyCommand(sub, rest); }
    catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
};

export const githubModule: CliModule = {
  names: ["github"],
  async run(sub, rest) {
    try {
      process.exitCode = await (await import("../../github/cli")).githubCommand(sub, rest);
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
};
