// src/fuzzer/index.ts — Fuzzer para instaladores de TUIs y despacho de herramientas MCP.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installIntoStandardMcpTui, installIntoOpencode } from "../tui";
import { dispatchIsyMcpAction } from "../mcp/gateway";
import { executeShellCommand } from "../shell/executor";

export interface FuzzReport {
  name: string;
  iterations: number;
  passed: number;
  failed: number;
  crashes: number;
  duration_ms: number;
  anomalies: string[];
}

export interface FullFuzzReport {
  ok: boolean;
  total_iterations: number;
  total_crashes: number;
  duration_ms: number;
  reports: FuzzReport[];
}

/** Genera mutaciones sintácticas y semánticas de prueba para archivos JSON. */
export function generateFuzzJsonPayloads(): string[] {
  return [
    "", // Vacío
    "   \n  \t  ", // Solo espacios
    "{}", // Objeto vacío
    "[]", // Array vacío
    "null",
    "true",
    "12345",
    '"string_literal"',
    "{", // JSON trunco
    '{"mcpServers":',
    '{"mcpServers": null}',
    '{"mcpServers": []}',
    '{"mcpServers": "cadena_no_objeto"}',
    '{"mcpServers": 12345}',
    '{"mcpServers": {"existing": {"command": "node"}}}',
    '{"__proto__": {"polluted": true}}',
    '{"constructor": {"prototype": {"admin": true}}}',
    '{"mcpServers": {}, "trailing_garbage": true} EXTRA_CHARS_AFTER_JSON',
    "{\n  // comentario json no valido\n  \"test\": 1\n}",
    '{"unicode_test": "🚀⚡🔥🤖\\u0000\\uFEFF\\uD83D\\uDE00"}',
    '{"long_string": "' + "A".repeat(50000) + '"}',
    "{\n" + Array.from({ length: 500 }, (_, i) => `  "key_${i}": "val_${i}"`).join(",\n") + "\n}",
  ];
}

/** Fuzzer de configuración: evalúa la resistencia del instalador de TUIs ante entradas malformadas. */
export async function runConfigFuzzer(iterations: number = 50): Promise<FuzzReport> {
  const started = Date.now();
  const payloads = generateFuzzJsonPayloads();
  let passed = 0;
  let failed = 0;
  let crashes = 0;
  const anomalies: string[] = [];

  const tempRoot = mkdtempSync(join(tmpdir(), "isymcp-fuzz-cfg-"));

  try {
    for (let i = 0; i < iterations; i++) {
      const payload = payloads[i % payloads.length];
      const testDir = join(tempRoot, `run-${i}`);
      const cfgPath = join(testDir, "config.json");
      const backupsDir = join(testDir, "backups");

      try {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(testDir, { recursive: true });
        writeFileSync(cfgPath, payload, "utf8");

        // Intentar instalar
        try {
          const res = installIntoStandardMcpTui({
            configPath: cfgPath,
            backupsDir,
            mcpMain: "/tmp/fake-main.ts",
            dryRun: false,
            tuiId: `fuzz-${i}`,
          });

          // Si pasó, el resultado debe ser un JSON válido que contenga mcpServers.isymcp
          const content = readFileSync(cfgPath, "utf8");
          const parsed = JSON.parse(content);
          if (!parsed.mcpServers || !parsed.mcpServers.isymcp) {
            anomalies.push(`Iteración ${i}: el archivo guardado no contiene mcpServers.isymcp`);
            failed++;
          } else {
            passed++;
          }
        } catch (err: any) {
          // Si el payload era sintácticamente inválido, el instalador DEBE lanzar un error controlado
          if (err.message.includes("JSON") || err.message.includes("Error al leer archivo")) {
            passed++; // Rechazo controlado esperado
          } else {
            anomalies.push(`Iteración ${i}: excepción inesperada con payload '${payload.slice(0, 30)}': ${err.message}`);
            crashes++;
          }
        }
      } catch (outerErr: any) {
        anomalies.push(`Error en setup iteración ${i}: ${outerErr.message}`);
        crashes++;
      }
    }
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* ignore cleanup */
    }
  }

  return {
    name: "TUI Config Installer Fuzzer",
    iterations,
    passed,
    failed,
    crashes,
    duration_ms: Date.now() - started,
    anomalies,
  };
}

/** Genera mutaciones adversariales para la herramienta Universal Gateway y Shell. */
export function generateFuzzMcpActions(): Array<{ action?: any; args?: any }> {
  return [
    { action: undefined, args: undefined },
    { action: "", args: {} },
    { action: "   ", args: {} },
    { action: "glossary", args: {} },
    { action: "describe", args: {} },
    { action: "describe", args: { name: "nonexistent_tool_12345" } },
    { action: "protocol", args: {} },
    { action: "unknown_family.action", args: {} },
    { action: "../../etc/passwd", args: {} },
    { action: "shell.exec", args: { command: "" } },
    { action: "shell.exec", args: { command: "   " } },
    { action: "shell.exec", args: { command: "echo 'FUZZ_OK'" } },
    { action: "shell.exec", args: { command: "cd /nonexistent_directory_98765" } },
    { action: "shell.exec", args: { command: "echo $PATH | grep -q bin" } },
    { action: "shell.exec", args: { command: "exit 42" } },
    { action: "shell.exec", args: { command: "sleep 2", timeout_ms: 100 } },
    { action: "shell.exec", args: { command: "echo " + "X".repeat(10000) } },
    { action: "tui.spawn", args: { dryRun: true, prompt: "Fuzz prompt" } },
    { action: "monitor.status", args: {} },
    { action: "monitor.tasks", args: { limit: -1 } },
    { action: "monitor.tasks", args: { limit: "invalid_number" } },
    { action: "__proto__", args: {} },
    { action: "constructor", args: {} },
    { action: 12345 as any, args: {} },
    { action: ["array", "action"] as any, args: {} },
  ];
}

/** Fuzzer de MCP Gateway y Shell: somete al despachador a cargas extremas para verificar robustez. */
export async function runMcpPayloadFuzzer(iterations: number = 50): Promise<FuzzReport> {
  const started = Date.now();
  const cases = generateFuzzMcpActions();
  let passed = 0;
  let failed = 0;
  let crashes = 0;
  const anomalies: string[] = [];

  for (let i = 0; i < iterations; i++) {
    const testCase = cases[i % cases.length];
    try {
      const res = await dispatchIsyMcpAction(testCase.action, testCase.args);
      if (typeof res !== "object" || typeof res.ok !== "boolean") {
        anomalies.push(`Iteración ${i}: respuesta no conforme con shape de gateway: ${JSON.stringify(res)}`);
        failed++;
      } else {
        passed++;
      }
    } catch (err: any) {
      anomalies.push(`Iteración ${i}: excepción no capturada en gateway con acción '${String(testCase.action)}': ${err.message}`);
      crashes++;
    }
  }

  return {
    name: "MCP Universal Gateway & Shell Fuzzer",
    iterations,
    passed,
    failed,
    crashes,
    duration_ms: Date.now() - started,
    anomalies,
  };
}

/** Ejecuta la suite completa de fuzzing. */
export async function runFullFuzzSuite(iterationsPerSuite: number = 50): Promise<FullFuzzReport> {
  const started = Date.now();
  const cfgReport = await runConfigFuzzer(iterationsPerSuite);
  const mcpReport = await runMcpPayloadFuzzer(iterationsPerSuite);

  const totalCrashes = cfgReport.crashes + mcpReport.crashes;
  const totalIterations = cfgReport.iterations + mcpReport.iterations;

  return {
    ok: totalCrashes === 0,
    total_iterations: totalIterations,
    total_crashes: totalCrashes,
    duration_ms: Date.now() - started,
    reports: [cfgReport, mcpReport],
  };
}
