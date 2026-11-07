// tests/github-extension.test.ts — Pruebas unitarias para la extensión de GitHub en ISyMCP.
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  loadStoredTokens,
  saveStoredTokens,
  registerToken,
  setActiveToken,
  removeToken,
  resolveActiveGitHubToken,
  validateGitHubToken,
  StoredGitHubToken,
} from "../src/github/tokens";
import { callGitHubApi } from "../src/github/client";
import { githubCommand } from "../src/github/cli";

const SECRETS_DIR = join(homedir(), ".codex-web-http", "secrets");
const TOKENS_FILE = join(SECRETS_DIR, "github-tokens.json");
const BACKUP_FILE = join(SECRETS_DIR, "github-tokens.json.testbak");

describe("ISyMCP GitHub Extension Suite", () => {
  beforeEach(() => {
    if (!existsSync(SECRETS_DIR)) mkdirSync(SECRETS_DIR, { recursive: true });
    if (existsSync(TOKENS_FILE)) {
      writeFileSync(BACKUP_FILE, Bun.file(TOKENS_FILE));
    }
  });

  afterEach(() => {
    if (existsSync(BACKUP_FILE)) {
      writeFileSync(TOKENS_FILE, Bun.file(BACKUP_FILE));
      try { unlinkSync(BACKUP_FILE); } catch {}
    } else {
      try { unlinkSync(TOKENS_FILE); } catch {}
    }
  });

  it("GHE-01: Token validation rejects empty or malformed token", async () => {
    const res = await validateGitHubToken("");
    expect(res.valid).toBe(false);
    expect(res.error).toBeDefined();

    const res2 = await validateGitHubToken("   ");
    expect(res2.valid).toBe(false);
  });

  it("GHE-02: Storing and loading tokens preserves TTL in hours and calculates expiration", async () => {
    const now = Date.now();
    const mockToken: StoredGitHubToken = {
      alias: "test-pat",
      token: "ghp_mocktoken12345678901234567890123456",
      login: "DannyBaanks",
      scopes: ["repo", "workflow"],
      created_at: now,
      expires_at: now + 8 * 3600 * 1000, // 8 horas
      ttl_hours: 8,
      active: true,
      source: "manual",
    };

    saveStoredTokens([mockToken]);
    const loaded = loadStoredTokens();
    expect(loaded.length).toBe(1);
    expect(loaded[0].alias).toBe("test-pat");
    expect(loaded[0].ttl_hours).toBe(8);
    expect(loaded[0].expires_at).toBeGreaterThan(now);
  });

  it("GHE-03: Expired token fails closed and is marked as expired", async () => {
    const pastTime = Date.now() - 3600 * 1000; // Expiró hace 1 hora
    const mockToken: StoredGitHubToken = {
      alias: "expired-token",
      token: "ghp_expired12345678901234567890123456",
      login: "DannyBaanks",
      scopes: ["repo"],
      created_at: pastTime - 8 * 3600 * 1000,
      expires_at: pastTime,
      ttl_hours: 8,
      active: true,
      source: "manual",
    };

    saveStoredTokens([mockToken]);
    const resolved = await resolveActiveGitHubToken();
    // Debe detectar que el token expiró y no retornarlo como un token válido activo
    if (resolved.alias === "expired-token") {
      expect(resolved.is_expired).toBe(true);
    } else {
      // Cayó en el fallback de gh auth token o env
      expect(resolved.source).not.toBe("stored");
    }
  });

  it("GHE-04: Token switching with setActiveToken updates active flags correctly", () => {
    const tokenA: StoredGitHubToken = {
      alias: "token-a",
      token: "ghp_aaaa12345678901234567890123456",
      login: "DannyBaanks",
      scopes: ["repo"],
      created_at: Date.now(),
      expires_at: null,
      ttl_hours: null,
      active: true,
      source: "manual",
    };
    const tokenB: StoredGitHubToken = {
      alias: "token-b",
      token: "ghp_bbbb12345678901234567890123456",
      login: "DannyBaanks",
      scopes: ["repo", "workflow"],
      created_at: Date.now(),
      expires_at: null,
      ttl_hours: null,
      active: false,
      source: "manual",
    };

    saveStoredTokens([tokenA, tokenB]);
    expect(loadStoredTokens().find((t) => t.alias === "token-a")?.active).toBe(true);

    const switchRes = setActiveToken("token-b");
    expect(switchRes.ok).toBe(true);

    const updated = loadStoredTokens();
    expect(updated.find((t) => t.alias === "token-a")?.active).toBe(false);
    expect(updated.find((t) => t.alias === "token-b")?.active).toBe(true);
  });

  it("GHE-05: Removing a token removes it from storage and reassigns active if necessary", () => {
    const tokenA: StoredGitHubToken = {
      alias: "token-a",
      token: "ghp_aaaa12345678901234567890123456",
      login: "DannyBaanks",
      scopes: ["repo"],
      created_at: Date.now(),
      expires_at: null,
      ttl_hours: null,
      active: true,
      source: "manual",
    };
    const tokenB: StoredGitHubToken = {
      alias: "token-b",
      token: "ghp_bbbb12345678901234567890123456",
      login: "DannyBaanks",
      scopes: ["repo"],
      created_at: Date.now(),
      expires_at: null,
      ttl_hours: null,
      active: false,
      source: "manual",
    };

    saveStoredTokens([tokenA, tokenB]);
    const delRes = removeToken("token-a");
    expect(delRes.ok).toBe(true);
    expect(delRes.removed?.alias).toBe("token-a");

    const remaining = loadStoredTokens();
    expect(remaining.length).toBe(1);
    expect(remaining[0].alias).toBe("token-b");
    expect(remaining[0].active).toBe(true);
  });

  it("GHE-06: CLI routing handles help and status gracefully", async () => {
    const codeHelp = await githubCommand("help");
    expect(codeHelp).toBe(0);

    const codeTokens = await githubCommand("tokens", ["list"]);
    expect(codeTokens).toBe(0);

    const codeUnknown = await githubCommand("unsupported-action-xyz");
    expect(codeUnknown).toBe(1);
  });
});
