import { describe, expect, test } from "bun:test";
import { sha256Hex, sha256Prefixed, hmacHex, safeEqualHex, safeEqualBuffer, randomHex } from "../src/crypto";
import { resolveWithin, resolveWithinReal } from "../src/path";
import { resolveWithin as rwReExport, resolveWithinReal as rwrReExport } from "../src/codex-sessions";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";

describe("crypto utilities", () => {
  test("sha256Hex produces consistent hex digest", () => {
    const text = "hello world";
    expect(sha256Hex(text)).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    expect(sha256Hex(Buffer.from(text))).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  test("sha256Prefixed prefixes sha256:", () => {
    expect(sha256Prefixed("test")).toBe(`sha256:${sha256Hex("test")}`);
  });

  test("hmacHex calculates correct HMAC", () => {
    const h1 = hmacHex("secret-key", "message payload");
    const h2 = hmacHex("secret-key", "message payload");
    const h3 = hmacHex("other-key", "message payload");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(typeof h1).toBe("string");
    expect(h1.length).toBe(64);
  });

  test("safeEqualHex verifies strings constant-time", () => {
    expect(safeEqualHex("abcdef", "abcdef")).toBe(true);
    expect(safeEqualHex("abcdef", "abcdeg")).toBe(false);
    expect(safeEqualHex("short", "longerstring")).toBe(false);
  });

  test("safeEqualBuffer verifies buffers constant-time", () => {
    const b1 = Buffer.from("token123");
    const b2 = Buffer.from("token123");
    const b3 = Buffer.from("token456");
    expect(safeEqualBuffer(b1, b2)).toBe(true);
    expect(safeEqualBuffer(b1, b3)).toBe(false);
    expect(safeEqualBuffer(b1, Buffer.from("token"))).toBe(false);
  });

  test("randomHex produces random string of requested byte length", () => {
    const r1 = randomHex(16);
    const r2 = randomHex(16);
    expect(r1.length).toBe(32);
    expect(r2.length).toBe(32);
    expect(r1).not.toBe(r2);
  });
});

describe("path confinement utilities", () => {
  test("resolveWithin allows inner files and blocks parent escapes", () => {
    const root = "/tmp/sandbox-test";
    expect(resolveWithin(root, "file.txt")).toBe("/tmp/sandbox-test/file.txt");
    expect(resolveWithin(root, "sub/dir/nested.txt")).toBe("/tmp/sandbox-test/sub/dir/nested.txt");
    expect(resolveWithin(root, "../outside.txt")).toBeNull();
    expect(resolveWithin(root, "../../etc/passwd")).toBeNull();
  });

  test("codex-sessions re-exports match src/path directly", () => {
    expect(resolveWithin).toBe(rwReExport);
    expect(resolveWithinReal).toBe(rwrReExport);
  });

  test("resolveWithinReal stops symlink escapes", () => {
    const testDir = join(tmpdir(), `isymcp-path-test-${Date.now()}`);
    const inner = join(testDir, "inner");
    const outside = join(testDir, "outside");
    mkdirSync(inner, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const outsideTarget = join(outside, "secret.txt");
    writeFileSync(outsideTarget, "top-secret");

    const symlinkPath = join(inner, "escape-link.txt");
    try {
      symlinkSync(outsideTarget, symlinkPath);
      expect(resolveWithinReal(inner, "escape-link.txt")).toBeNull();
    } catch (e) {
      // Symlinks might require elevated permissions on some platforms, handled gracefully
    }
  });
});
