// src/cli/commands/diagnostics.ts — `isymcp health|metrics|smoke|doctor|tree`.
import { bridgeAuthHeaders } from "../../local-guard";
import { status } from "./status";
import type { CliModule } from "../module";
import { brandHeader, visibleLabels } from "../../menu";

export async function smokeCommand(sub?: string, rest: string[] = []): Promise<void> {
  const json = sub === "--json" || rest.includes("--json");
  const { runE2EAll } = await import("../../../scripts/e2e-all");
  const result = await runE2EAll({ quiet: json });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.ok) process.exit(1);
}

export async function metricsCommand(sub?: string, rest: string[] = []): Promise<void> {
  const json = sub === "--json" || rest.includes("--json");
  const prometheus = sub === "--prom" || sub === "--prometheus" || rest.includes("--prom") || rest.includes("--prometheus");
  const port = process.env.CODEX_WEB_HTTP_PORT?.trim() || "8791";
  const { bridgeAuthHeaders } = await import("../../local-guard");
  try {
    if (prometheus) {
      const r = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: bridgeAuthHeaders() });
      if (!r.ok) throw new Error(`bridge devolvio HTTP ${r.status}`);
      console.log(await r.text());
      return;
    }
    const r = await fetch(`http://127.0.0.1:${port}/api/metrics`, { headers: bridgeAuthHeaders() });
    if (!r.ok) throw new Error(`bridge devolvio HTTP ${r.status}`);
    const data = await r.json();
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const { getMetrics } = await import("../../metrics");
    const m = data as ReturnType<typeof getMetrics>;
    console.log(`ISyMCP Telemetría en Vivo (Uptime: ${m.uptimeSeconds}s)`);
    console.log(`  Turnos:       ${m.turns.total} total (${m.turns.success} ok, ${m.turns.failed} err, ${m.turns.reasoning_turns} con pensamiento)`);
    console.log(`  Latencia:     avg ${m.latency_ms.avg} ms · min ${m.latency_ms.min} ms · max ${m.latency_ms.max} ms`);
    console.log(`  Tokens est.:  ${m.tokens.total_tokens_estimated.toLocaleString()} total (${m.tokens.prompt_tokens_estimated} prompt, ${
      m.tokens.completion_tokens_estimated} compl, ${m.tokens.reasoning_tokens_estimated} reasoning)`);
    console.log(`  Memoria:      ${(m.memory.rss_bytes / (1024 * 1024)).toFixed(1)} MB RSS · ${(m.memory.heap_used_bytes / (1024 * 1024)).toFixed(1)} MB Heap`);
    if (Object.keys(m.errors_by_type).length > 0) {
      console.log(`  Errores:      ${Object.entries(m.errors_by_type).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  } catch (err) {
    console.error(`Error obteniendo métricas (¿el bridge está encendido en :${port}?): ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export async function healthCommand(sub?: string, rest: string[] = []): Promise<void> {
  const json = sub === "--json" || rest.includes("--json");
  const port = process.env.CODEX_WEB_HTTP_PORT?.trim() || "8791";
  const { bridgeAuthHeaders } = await import("../../local-guard");
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: bridgeAuthHeaders() });
    if (!r.ok) throw new Error(`bridge devolvio HTTP ${r.status}`);
    const data = await r.json() as { status: string; uptime_seconds: number; web_models: string; upstream: string; turns?: { total: number; success: number } };
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(`ISyMCP Estado de Salud: ${data.status.toUpperCase()} ✓`);
    console.log(`  Uptime:       ${data.uptime_seconds}s`);
    console.log(`  Modelos Web:  ${data.web_models}`);
    console.log(`  Upstream:     ${data.upstream}`);
    console.log(`  Turnos:       ${data.turns?.total ?? 0} procesados (${data.turns?.success ?? 0} exitosos)`);
  } catch (err) {
    console.error(`Bridge no disponible en :${port}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export const smokeModule: CliModule = { names: ["smoke", "e2e"], run: (sub, rest) => smokeCommand(sub, rest) };
export const metricsModule: CliModule = { names: ["metrics"], run: (sub, rest) => metricsCommand(sub, rest) };
export const healthModule: CliModule = { names: ["health"], run: (sub, rest) => healthCommand(sub, rest) };

export const doctorModule: CliModule = {
  names: ["doctor"],
  async run(sub, rest) {
    const { runDoctor, formatDoctor, mediaStateHome } = await import("../../doctor");
    const json = sub === "--json" || rest.includes("--json");
    const explain = sub === "--explain" || rest.includes("--explain");
    const report = runDoctor();
    console.log(json ? JSON.stringify(report, null, 2) : formatDoctor(report));
    if (explain) {
      const { explainReport, defaultExplainRunner } = await import("../../doctor-explain");
      const runner = defaultExplainRunner();
      if (!runner) {
        console.log("\nexplicacion: sin motor configurado (exporta ISYMCP_EXPLAIN_CMD); los remedios de arriba son deterministas.");
      } else {
        const text = await explainReport(report, runner);
        console.log("\nexplicacion (modelo local; no se ejecuta nada de lo que proponga)");
        console.log(text ? `  ${text.replace(/\n/g, "\n  ")}` : "  sin respuesta del motor; usa los remedios deterministas de arriba.");
      }
    }
    const argv = [sub, ...rest].filter((value): value is string => typeof value === "string");
    const fixAt = argv.indexOf("--fix");
    if (fixAt !== -1) {
      const { applyFix, listFixActions, planFix } = await import("../../doctor-fix");
      const action = argv[fixAt + 1] && !argv[fixAt + 1].startsWith("--") ? argv[fixAt + 1] : "";
      if (!action) {
        console.error(`✗ --fix requiere una accion; permitidas: ${listFixActions().join(", ")}`);
        process.exitCode = 1;
      } else if (!argv.includes("--apply")) {
        try {
          console.log(`\nplan --fix ${action}: ${planFix(action)}\n  (dry-run; añade --apply para ejecutarla)`);
        } catch (error) {
          console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      } else {
        try {
          const result = applyFix(action, { mediaHome: mediaStateHome() });
          console.log(`\n--fix ${action}: ${result.detail}`);
        } catch (error) {
          console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      }
    }
    if (!report.ok) process.exitCode = 1;
  },
};

export const treeModule: CliModule = {
  names: ["tree"],
  async run() {
    console.log(brandHeader());
    for (const label of visibleLabels()) console.log(`  ${label}`);
    const leaked = visibleLabels().filter((label) => label.startsWith("hook."));
    if (leaked.length) throw new Error(`hook visible: ${leaked.join(",")}`);
  },
};
