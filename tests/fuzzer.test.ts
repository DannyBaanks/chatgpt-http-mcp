// tests/fuzzer.test.ts — Pruebas para la suite de fuzzing de TUIs y MCP Gateway.
import { describe, expect, it } from "bun:test";
import { runConfigFuzzer, runMcpPayloadFuzzer, runFullFuzzSuite } from "../src/fuzzer";

describe("ISyMCP Fuzzer Suite", () => {
  it("FZ-01: config fuzzer survives adversarial JSON inputs without unhandled crashes", async () => {
    const report = await runConfigFuzzer(30);
    expect(report.iterations).toBe(30);
    expect(report.crashes).toBe(0);
    expect(report.passed).toBeGreaterThan(0);
    expect(report.anomalies.length).toBe(0);
  });

  it("FZ-02: mcp payload fuzzer survives hostile gateway actions without process termination", async () => {
    const report = await runMcpPayloadFuzzer(30);
    expect(report.iterations).toBe(30);
    expect(report.crashes).toBe(0);
    expect(report.passed).toBe(30);
    expect(report.anomalies.length).toBe(0);
  });

  it("FZ-03: full fuzz suite runs both suites and aggregates results", async () => {
    const full = await runFullFuzzSuite(15);
    expect(full.ok).toBe(true);
    expect(full.total_crashes).toBe(0);
    expect(full.total_iterations).toBe(30);
    expect(full.reports.length).toBe(2);
  });
});
