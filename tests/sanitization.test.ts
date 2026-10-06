// M8 (P0): el sanitizer redacta, y la evidencia real no contiene secretos.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SECRET_PATTERNS, sanitizeEvidenceText } from "../src/sanitize";

const ROOT = join(import.meta.dir, "..");

describe("M8: sanitizer", () => {
  test("redacta turn_token, bearer, sk- y cookies; no toca texto benigno", () => {
    const raw = [
      "turn_token: ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      "key sk-abcdefghijklmnopqrstuvwx",
      '__Secure-next-auth.session-token=abcdef1234567890',
      "texto normal sin secretos",
    ].join("\n");
    const clean = sanitizeEvidenceText(raw);
    expect(clean).toContain("turn_token: <redacted>");
    expect(clean).toContain("Bearer <redacted>");
    expect(clean).toContain("sk-<redacted>");
    expect(clean).toContain("texto normal sin secretos");
    for (const pattern of SECRET_PATTERNS) expect(pattern.test(clean)).toBe(false);
  });

  test("la evidencia versionada no contiene secretos (scan real)", () => {
    const files: string[] = [];
    const ev = join(ROOT, "docs", "evidence");
    if (existsSync(ev)) for (const f of readdirSync(ev)) if (f.endsWith(".json")) files.push(join(ev, f));
    const fixture = join(ROOT, "tests", "fixtures", "capture-fail-container.json");
    if (existsSync(fixture)) files.push(fixture);
    const trace = join(homedir(), ".codex-web-http", "mcp-trace.log");
    if (existsSync(trace)) files.push(trace);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of SECRET_PATTERNS) {
        const hit = pattern.exec(text);
        expect(hit === null ? "" : `${file}: ${hit[0].slice(0, 60)}`).toBe("");
      }
    }
  });
});
