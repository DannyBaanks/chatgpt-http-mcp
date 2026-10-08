// metrics.test.ts — pruebas del motor de metricas, endpoints y observabilidad en vivo.
import { beforeEach, describe, expect, test } from "bun:test";
import { formatPrometheusMetrics, getMetrics, recordTurn, resetMetricsForTest } from "../src/metrics";
import { createHandler } from "../src/server";
import { loadConfig } from "../src/config";
import { buildPanelState, renderMain } from "../src/panel";

describe("motor de métricas y telemetría (src/metrics.ts)", () => {
  beforeEach(() => {
    resetMetricsForTest();
  });

  test("registra turnos exitosos, fallidos, tokens y latencias", () => {
    recordTurn({
      durationMs: 120,
      ok: true,
      promptTokens: 50,
      completionTokens: 80,
      reasoningTokens: 30,
    });

    recordTurn({
      durationMs: 300,
      ok: false,
      errorType: "upstream_timeout",
      promptTokens: 40,
    });

    const m = getMetrics();
    expect(m.turns.total).toBe(2);
    expect(m.turns.success).toBe(1);
    expect(m.turns.failed).toBe(1);
    expect(m.turns.reasoning_turns).toBe(1);

    expect(m.tokens.prompt_tokens_estimated).toBe(90);
    expect(m.tokens.completion_tokens_estimated).toBe(80);
    expect(m.tokens.reasoning_tokens_estimated).toBe(30);
    expect(m.tokens.total_tokens_estimated).toBe(200);

    expect(m.latency_ms.avg).toBe(210);
    expect(m.latency_ms.min).toBe(120);
    expect(m.latency_ms.max).toBe(300);
    expect(m.latency_ms.recent).toEqual([120, 300]);

    expect(m.errors_by_type.upstream_timeout).toBe(1);
    expect(m.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(m.memory.rss_bytes).toBeGreaterThan(0);
  });

  test("formatea métricas en formato Prometheus / OpenMetrics", () => {
    recordTurn({
      durationMs: 250,
      ok: true,
      promptTokens: 100,
      completionTokens: 200,
      reasoningTokens: 50,
    });

    const prom = formatPrometheusMetrics();
    expect(prom).toContain("# TYPE isymcp_turns_total counter");
    expect(prom).toContain('isymcp_turns_total{status="success"} 1');
    expect(prom).toContain('isymcp_turns_total{status="reasoning"} 1');
    expect(prom).toContain('isymcp_tokens_estimated_total{type="reasoning"} 50');
    expect(prom).toContain('isymcp_latency_ms{stat="avg"} 250');
    expect(prom).toContain("isymcp_memory_bytes{area=\"rss\"}");
  });
});

describe("endpoints de telemetría y salud en el bridge (server.ts)", () => {
  beforeEach(() => {
    resetMetricsForTest();
  });

  test("GET /metrics devuelve OpenMetrics en texto plano", async () => {
    const config = loadConfig();
    const handler = createHandler(config);

    recordTurn({ durationMs: 150, ok: true, promptTokens: 20, completionTokens: 40 });

    const req = new Request("http://127.0.0.1:8791/metrics", { method: "GET" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("isymcp_turns_total");
  });

  test("GET /api/metrics devuelve JSON estructurado", async () => {
    const config = loadConfig();
    const handler = createHandler(config);

    recordTurn({ durationMs: 200, ok: true });

    const req = new Request("http://127.0.0.1:8791/api/metrics", { method: "GET" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const data = await res.json() as ReturnType<typeof getMetrics>;
    expect(data.turns.total).toBe(1);
    expect(data.latency_ms.avg).toBe(200);
  });

  test("GET /api/health y /health devuelven estado de salud completo", async () => {
    const config = loadConfig();
    const handler = createHandler(config);

    const req = new Request("http://127.0.0.1:8791/api/health", { method: "GET" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const data = await res.json() as { status: string; turns: { total: number } };
    expect(data.status).toBe("ok");
    expect(data).toHaveProperty("uptime_seconds");
    expect(data).toHaveProperty("turns");
  });
});

describe("renderizado de métricas en el panel visual (panel.ts)", () => {
  test("renderMain incluye la tarjeta de métricas con telemetría", () => {
    const metrics = {
      startedAt: new Date().toISOString(),
      uptimeSeconds: 3665,
      turns: { total: 42, success: 40, failed: 2, reasoning_turns: 15 },
      tokens: {
        prompt_tokens_estimated: 12000,
        completion_tokens_estimated: 25000,
        reasoning_tokens_estimated: 8000,
        total_tokens_estimated: 45000,
      },
      latency_ms: { avg: 1450, min: 300, max: 4200, recent: [1450] },
      errors_by_type: { timeout: 2 },
      memory: { rss_bytes: 85 * 1024 * 1024, heap_used_bytes: 40 * 1024 * 1024, heap_total_bytes: 60 * 1024 * 1024 },
    };

    const state = {
      ts: new Date().toISOString(),
      server: "up" as const,
      serverPort: "8791",
      tunnel: "ready" as const,
      mcp: "up" as const,
      browser: "ok" as const,
      conversation: null,
      sessions: [],
      lastErrors: [],
      metrics,
    };

    const html = renderMain(state);
    expect(html).toContain("MÉTRICAS &amp; OBSERVABILIDAD");
    expect(html).toContain("Turnos Totales");
    expect(html).toContain("42");
    expect(html).toContain("Éxitos");
    expect(html).toContain("40");
    expect(html).toContain("Fallos");
    expect(html).toContain("2");
    expect(html).toContain("Con Pensamiento");
    expect(html).toContain("15");
    expect(html).toContain("1450 ms");
    expect(html).toContain("45,000");
  });
});
