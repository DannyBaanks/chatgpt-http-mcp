import { describe, expect, test } from "bun:test";
import { inWindow, parseBound, parseTime, selectLines, type LogLine } from "../src/logs";

const lines: LogLine[] = [
  { source: "tunnel", time: "2026-10-02T16:00:00-06:00", text: "a" },
  { source: "tunnel", time: "2026-10-02T16:30:00-06:00", text: "b" },
  { source: "server", time: "2026-10-02T17:00:00-06:00", text: "c" },
  { source: "server", time: null, text: "sin hora" },
];

describe("parseTime", () => {
  test("saca time del JSON del tunnel", () => {
    expect(parseTime('{"time":"2026-10-02T16:47:02.828-06:00","msg":"x"}')).toBe("2026-10-02T16:47:02.828-06:00");
  });
  test("linea sin hora queda null", () => {
    expect(parseTime("listening on 8791")).toBeNull();
  });
});

describe("selectLines", () => {
  test("ultimos N", () => {
    expect(selectLines(lines, { last: 2 }).map((l) => l.text)).toEqual(["c", "sin hora"]);
  });
  test("ventana de fecha excluye las sin hora", () => {
    const since = parseBound("2026-10-02T16:15:00-06:00");
    const until = parseBound("2026-10-02T16:45:00-06:00");
    const got = selectLines(lines, { sinceMs: since, untilMs: until });
    expect(got.map((l) => l.text)).toEqual(["b"]);
  });
  test("sin filtro incluye las sin hora", () => {
    expect(inWindow(lines[3])).toBe(true);
  });
});
