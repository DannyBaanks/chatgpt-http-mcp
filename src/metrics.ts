// metrics.ts — telemetria y metricas en vivo para ISyMCP.
// Registra turnos, latencias, consumo estimado de tokens (incluyendo reasoning),
// clasificacion de errores y uso de memoria sin sobrecarga en runtime.

export interface TurnRecord {
  durationMs: number;
  ok: boolean;
  errorType?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
}

export interface SystemMetrics {
  startedAt: string;
  uptimeSeconds: number;
  turns: {
    total: number;
    success: number;
    failed: number;
    reasoning_turns: number;
  };
  tokens: {
    prompt_tokens_estimated: number;
    completion_tokens_estimated: number;
    reasoning_tokens_estimated: number;
    total_tokens_estimated: number;
  };
  latency_ms: {
    avg: number;
    min: number;
    max: number;
    recent: number[];
  };
  errors_by_type: Record<string, number>;
  memory: {
    rss_bytes: number;
    heap_used_bytes: number;
    heap_total_bytes: number;
  };
}

const startTime = Date.now();
let turnsTotal = 0;
let turnsSuccess = 0;
let turnsFailed = 0;
let reasoningTurnsTotal = 0;
let promptTokensTotal = 0;
let completionTokensTotal = 0;
let reasoningTokensTotal = 0;
let totalDurationMs = 0;
let minDurationMs = 0;
let maxDurationMs = 0;
const recentLatencies: number[] = [];
const errorsByType: Record<string, number> = {};

export function recordTurn(record: TurnRecord): void {
  turnsTotal += 1;
  if (record.ok) {
    turnsSuccess += 1;
  } else {
    turnsFailed += 1;
    const err = record.errorType || "unknown_error";
    errorsByType[err] = (errorsByType[err] || 0) + 1;
  }

  if (record.reasoningTokens && record.reasoningTokens > 0) {
    reasoningTurnsTotal += 1;
    reasoningTokensTotal += record.reasoningTokens;
  }

  if (record.promptTokens) promptTokensTotal += record.promptTokens;
  if (record.completionTokens) completionTokensTotal += record.completionTokens;

  totalDurationMs += record.durationMs;
  if (minDurationMs === 0 || record.durationMs < minDurationMs) minDurationMs = record.durationMs;
  if (record.durationMs > maxDurationMs) maxDurationMs = record.durationMs;

  recentLatencies.push(Math.round(record.durationMs));
  if (recentLatencies.length > 20) recentLatencies.shift();
}

export function getMetrics(): SystemMetrics {
  const mem = process.memoryUsage ? process.memoryUsage() : { rss: 0, heapUsed: 0, heapTotal: 0 };
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const avg = turnsTotal > 0 ? Math.round(totalDurationMs / turnsTotal) : 0;

  return {
    startedAt: new Date(startTime).toISOString(),
    uptimeSeconds,
    turns: {
      total: turnsTotal,
      success: turnsSuccess,
      failed: turnsFailed,
      reasoning_turns: reasoningTurnsTotal,
    },
    tokens: {
      prompt_tokens_estimated: promptTokensTotal,
      completion_tokens_estimated: completionTokensTotal,
      reasoning_tokens_estimated: reasoningTokensTotal,
      total_tokens_estimated: promptTokensTotal + completionTokensTotal + reasoningTokensTotal,
    },
    latency_ms: {
      avg,
      min: minDurationMs,
      max: maxDurationMs,
      recent: [...recentLatencies],
    },
    errors_by_type: { ...errorsByType },
    memory: {
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      heap_total_bytes: mem.heapTotal,
    },
  };
}

export function formatPrometheusMetrics(): string {
  const m = getMetrics();
  const lines: string[] = [
    "# HELP isymcp_uptime_seconds Process uptime in seconds",
    "# TYPE isymcp_uptime_seconds gauge",
    `isymcp_uptime_seconds ${m.uptimeSeconds}`,
    "",
    "# HELP isymcp_turns_total Total turns processed",
    "# TYPE isymcp_turns_total counter",
    `isymcp_turns_total{status="success"} ${m.turns.success}`,
    `isymcp_turns_total{status="failed"} ${m.turns.failed}`,
    `isymcp_turns_total{status="reasoning"} ${m.turns.reasoning_turns}`,
    "",
    "# HELP isymcp_tokens_estimated_total Total estimated tokens",
    "# TYPE isymcp_tokens_estimated_total counter",
    `isymcp_tokens_estimated_total{type="prompt"} ${m.tokens.prompt_tokens_estimated}`,
    `isymcp_tokens_estimated_total{type="completion"} ${m.tokens.completion_tokens_estimated}`,
    `isymcp_tokens_estimated_total{type="reasoning"} ${m.tokens.reasoning_tokens_estimated}`,
    "",
    "# HELP isymcp_latency_ms Latency stats in milliseconds",
    "# TYPE isymcp_latency_ms gauge",
    `isymcp_latency_ms{stat="avg"} ${m.latency_ms.avg}`,
    `isymcp_latency_ms{stat="min"} ${m.latency_ms.min}`,
    `isymcp_latency_ms{stat="max"} ${m.latency_ms.max}`,
    "",
    "# HELP isymcp_memory_bytes Process memory usage in bytes",
    "# TYPE isymcp_memory_bytes gauge",
    `isymcp_memory_bytes{area="rss"} ${m.memory.rss_bytes}`,
    `isymcp_memory_bytes{area="heap_used"} ${m.memory.heap_used_bytes}`,
    `isymcp_memory_bytes{area="heap_total"} ${m.memory.heap_total_bytes}`,
  ];

  for (const [err, count] of Object.entries(m.errors_by_type)) {
    lines.push(`isymcp_errors_total{error_type="${err}"} ${count}`);
  }

  return `${lines.join("\n")}\n`;
}

export function resetMetricsForTest(): void {
  turnsTotal = 0;
  turnsSuccess = 0;
  turnsFailed = 0;
  reasoningTurnsTotal = 0;
  promptTokensTotal = 0;
  completionTokensTotal = 0;
  reasoningTokensTotal = 0;
  totalDurationMs = 0;
  minDurationMs = 0;
  maxDurationMs = 0;
  recentLatencies.length = 0;
  for (const k of Object.keys(errorsByType)) delete errorsByType[k];
}
