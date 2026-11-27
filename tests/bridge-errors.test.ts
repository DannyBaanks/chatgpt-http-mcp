import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_ERRORS, diagnose, errorCatalog, errorsLogPath, recentErrors, recordError, TRANSPORT_HINT, tunnelHealth } from "../src/bridge-errors";
import { dispatchIsyMcpAction, gatewayToolPayload } from "../src/mcp/gateway";
import { TOOL_DESCRIPTIONS } from "../src/mcp/catalog";

function isolatedEnv() {
  const home = mkdtempSync(join(tmpdir(), "isymcp-errors-"));
  return { home, env: { ...process.env, CODEX_WEB_HTTP_HOME: home } as Record<string, string | undefined> };
}

describe("bridge-errors: diagnose", () => {
  test("el fallo real del 2026-11-27 (túnel atascado) se reconoce como transporte y lo arregla el operador", () => {
    const d = diagnose("INVALID_ARGUMENT: McpServerError: Session terminated");
    expect(d.code).toBe("transport_session_terminated");
    expect(d.layer).toBe("transport");
    expect(d.who_fixes).toBe("operator");
    expect(d.command).toContain("isymcp tunnel connect");
  });

  test.each([
    ["turn_token requerido", "turn_token_missing"],
    ["fail-closed: bwrap not found", "sandbox_unavailable"],
    ["DENIED: shell_exec ejecuta en el host sin sandbox; el operador lo habilita con `isymcp allow shell on`", "permission_denied"],
    ["cwd fuera del workspace o inexistente: /etc", "path_outside_workspace"],
    ["sesion read-only: apply_patch denegado", "session_read_only"],
    ["arguments no validos para codex_exec: command: expected array", "invalid_arguments"],
    ["exec_id desconocido o expirado", "exec_id_invalid"],
    ["tool dispatch failed: TypeError: x is undefined", "internal_crash"],
    ["broker not connected (V1 stub)", "turn_token_unknown"],
    ["Acción no soportada en el Gateway de ISyMCP: 'foo'", "tool_unsupported"],
    ["algo totalmente nuevo", "unknown"],
  ])("%s → %s", (message, code) => {
    expect(diagnose(message).code).toBe(code as keyof typeof BRIDGE_ERRORS);
  });

  test("un código del catálogo se explica a sí mismo", () => {
    expect(diagnose("permission_expired").code).toBe("permission_expired");
  });

  test("cada código tiene causa y remedio, y el catálogo público no expone regex", () => {
    for (const [code, rule] of Object.entries(errorCatalog())) {
      expect(rule.cause.length, code).toBeGreaterThan(10);
      expect(rule.remedy.length, code).toBeGreaterThan(10);
      expect("match" in rule).toBe(false);
    }
  });
});

describe("bridge-errors: exposición al modelo", () => {
  test("la descripción de codex_turn_start lleva el resumen de transporte (sirve aunque el túnel esté caído)", () => {
    expect(TOOL_DESCRIPTIONS.codex_turn_start).toContain(TRANSPORT_HINT);
    expect(TRANSPORT_HINT).toContain("Session terminated");
  });

  test("gateway errors.explain / errors.catalog", async () => {
    const ex = await dispatchIsyMcpAction("errors.explain", { message: "McpServerError: Session terminated" });
    expect(ex.ok).toBe(true);
    expect((ex.result as { code: string }).code).toBe("transport_session_terminated");
    const cat = await dispatchIsyMcpAction("errors.catalog", {});
    expect(Object.keys((cat.result as { codes: object }).codes)).toContain("permission_denied");
    const missing = await dispatchIsyMcpAction("errors.explain", {});
    expect(missing.ok).toBe(false);
  });

  test("un fallo del gateway llega al modelo con diagnosis", () => {
    const payload = gatewayToolPayload({ ok: false, result: null, error: "Acción no soportada en el Gateway de ISyMCP: 'x'" }) as Record<string, any>;
    expect(payload.diagnosis.code).toBe("tool_unsupported");
  });
});

describe("bridge-errors: bitácora y túnel", () => {
  test("recordError escribe 0600, redacta secretos y recentErrors lo devuelve diagnosticado", () => {
    const { env } = isolatedEnv();
    recordError("codex_exec", "fail-closed: bwrap not found Bearer abcdefghijklmnop", { session: "gpt-sandbox[abc]" }, env);
    const path = errorsLogPath(env);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("abcdefghijklmnop");
    const recent = recentErrors(5, env);
    expect(recent.tool_errors[0]!.code).toBe("sandbox_unavailable");
    expect(recent.tool_errors[0]!.diagnosis.who_fixes).toBe("operator");
  });

  test("recentErrors incluye denegaciones de permisos con su diagnosis", () => {
    const { home, env } = isolatedEnv();
    mkdirSync(join(home, "audit"), { recursive: true });
    writeFileSync(join(home, "audit", "gates.jsonl"),
      `${JSON.stringify({ ts: "2026-11-27T10:17:45Z", cap: "host_shell", action: "shell_exec", decision: "deny", reason: "expired", command: "ls" })}\n`);
    const recent = recentErrors(5, env);
    expect(recent.permission_denials[0]!.diagnosis.code).toBe("permission_expired");
  });

  test("tunnelHealth detecta un poller atascado (timeouts seguidos sin recuperación)", () => {
    const { home, env } = isolatedEnv();
    const log = join(home, "tunnel.log");
    const lines = [
      { time: "t0", msg: "poller recovered; polling operational" },
      { time: "t1", msg: "poll timed out; backing off" },
      { time: "t2", msg: "poll timed out; backing off" },
      { time: "t3", msg: "poll timed out; backing off" },
    ];
    writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    mkdirSync(join(home, "tunnel", "profiles"), { recursive: true });
    writeFileSync(join(home, "tunnel", "profiles", "demo.yaml"), JSON.stringify({ log: { file: log } }));
    const [h] = tunnelHealth(env);
    expect(h!.profile).toBe("demo");
    expect(h!.consecutive_poll_timeouts).toBe(3);
    expect(h!.stuck).toBe(true);
    expect(h!.last_event_at).toBe("t3");
  });
});
