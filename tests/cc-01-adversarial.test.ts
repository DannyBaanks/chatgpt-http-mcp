// tests/cc-01-adversarial.test.ts — Pruebas adversariales de frontera de autoridad para CC-01.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchControlCenterAction, getControlCenterTasks } from "../src/control-center/service";
import { handleControlCenterApi } from "../src/control-center/router";
import { guardLocalRequest, bridgeToken, bridgeAuthHeaders } from "../src/local-guard";
import { openBridgeMonitorStack } from "../src/remote-monitor";

let testEnv: Record<string, string>;

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "isymcp-cc01-adv-"));
  testEnv = {
    ...process.env,
    CODEX_WEB_HTTP_HOME: home,
    CODEX_WEB_HTTP_MONITOR_DB: join(home, "remote-monitor.sqlite"),
  };
});

describe("CC-01 Adversarial Suite — Falsación de Frontera de Autoridad", () => {
  describe("1. Ataques de Evasión por Alias y Normalización (Bypass Attempts)", () => {
    test("ADV-01: Intento de bypass usando alias 'exec' sin confirmación es BLOQUEADO", async () => {
      const res = await dispatchControlCenterAction("exec", { command: "whoami" }, { confirmed: false });
      expect(res.ok).toBe(false);
      expect(res.requires_confirmation).toBe(true);
      expect(res.action).toBe("shell.exec");
    });

    test("ADV-02: Intento de bypass usando alias 'shell' sin confirmación es BLOQUEADO", async () => {
      const res = await dispatchControlCenterAction("shell", { command: "cat /etc/passwd" }, { confirmed: false });
      expect(res.ok).toBe(false);
      expect(res.requires_confirmation).toBe(true);
      expect(res.action).toBe("shell.exec");
    });

    test("ADV-03: Intento de bypass usando alias 'bash' sin confirmación es BLOQUEADO", async () => {
      const res = await dispatchControlCenterAction("bash", { command: "ls" }, { confirmed: false });
      expect(res.ok).toBe(false);
      expect(res.requires_confirmation).toBe(true);
      expect(res.action).toBe("shell.exec");
    });

    test("ADV-04: Intento de bypass usando alias 'dispatch' sin confirmación es BLOQUEADO", async () => {
      const res = await dispatchControlCenterAction("dispatch", { workflow_id: "deploy.yml" }, { confirmed: false });
      expect(res.ok).toBe(false);
      expect(res.requires_confirmation).toBe(true);
      expect(res.action).toBe("github.dispatch");
    });

    test("ADV-05: Intento de bypass usando 'github.exec' sin confirmación es BLOQUEADO", async () => {
      const res = await dispatchControlCenterAction("github.exec", { args: ["release", "delete"] }, { confirmed: false });
      expect(res.ok).toBe(false);
      expect(res.requires_confirmation).toBe(true);
      expect(res.action).toBe("github.exec");
    });
  });

  describe("2. Confusión de Tipos en Confirmación (Type-Confusion Attacks)", () => {
    test("ADV-06: confirmed='true' (string truthy) es RECHAZADO como falso", async () => {
      const res = await dispatchControlCenterAction(
        "shell.exec",
        { command: "echo exploit" },
        { confirmed: "true" as any }
      );
      expect(res.ok).toBe(false);
      expect(res.requires_confirmation).toBe(true);
    });

    test("ADV-07: confirmed=1 (entero truthy) es RECHAZADO como falso", async () => {
      const res = await dispatchControlCenterAction(
        "shell.exec",
        { command: "echo exploit" },
        { confirmed: 1 as any }
      );
      expect(res.ok).toBe(false);
      expect(res.requires_confirmation).toBe(true);
    });

    test("ADV-08: confirmed={} (objeto truthy) es RECHAZADO como falso", async () => {
      const res = await dispatchControlCenterAction(
        "shell.exec",
        { command: "echo exploit" },
        { confirmed: {} as any }
      );
      expect(res.ok).toBe(false);
      expect(res.requires_confirmation).toBe(true);
    });
  });

  describe("3. Falsificación de Host, Origin y CSRF (Network Boundary)", () => {
    test("ADV-09: Solicitud con Host ajeno (DNS Rebinding) es RECHAZADA por guardLocalRequest", () => {
      const req = new Request("http://attacker.com/api/control-center/dispatch", {
        headers: { host: "attacker.com" },
      });
      const denied = guardLocalRequest(req, { loopbackOnly: true });
      expect(denied).not.toBeNull();
      expect(denied?.status).toBe(403);
    });

    test("ADV-10: Solicitud con Origin malicioso (CORS/CSRF) es RECHAZADA", () => {
      const req = new Request("http://127.0.0.1:8798/api/control-center/dispatch", {
        headers: { host: "127.0.0.1:8798", origin: "https://malicious-web.com" },
      });
      const denied = guardLocalRequest(req, { loopbackOnly: true });
      expect(denied).not.toBeNull();
      expect(denied?.status).toBe(403);
    });

    test("ADV-11: Mutación POST con Content-Type simple (text/plain CSRF) es RECHAZADA", () => {
      const req = new Request("http://127.0.0.1:8798/api/control-center/dispatch", {
        method: "POST",
        headers: {
          host: "127.0.0.1:8798",
          origin: "http://127.0.0.1:8798",
          "content-type": "text/plain",
        },
        body: JSON.stringify({ action: "shell.exec", arguments: { command: "id" } }),
      });
      const denied = guardLocalRequest(req, { requireJsonBody: true, loopbackOnly: true });
      expect(denied).not.toBeNull();
      expect(denied?.status).toBe(415); // Unsupported Media Type
    });
  });

  describe("4. Fuga de Secretos y Sanitización (Zero Token Leakage)", () => {
    test("ADV-12: Tokens de GitHub (ghp_...) en la salida de comandos son redactados automáticamente", async () => {
      const fakeToken = "ghp_111122223333444455556666777788889999";
      const res = await dispatchControlCenterAction(
        "shell.exec",
        { command: `echo "token=${fakeToken}"` },
        { confirmed: true }
      );
      expect(res.ok).toBe(true);
      const out = JSON.stringify(res.result);
      expect(out).not.toContain(fakeToken);
      expect(out).toContain("[REDACTED_GH_TOKEN]");
    });

    test("ADV-13: Tokens de QueueLease (ql_...) en respuestas son redactados automáticamente", async () => {
      const fakeLease = "ql_abcdef1234567890abcdef1234567890";
      const res = await dispatchControlCenterAction(
        "shell.exec",
        { command: `echo "lease=${fakeLease}"` },
        { confirmed: true }
      );
      expect(res.ok).toBe(true);
      const out = JSON.stringify(res.result);
      expect(out).not.toContain(fakeLease);
      expect(out).toContain("[REDACTED_LEASE_TOKEN]");
    });
  });

  describe("5. Aislamiento de TUI y Modos Peligrosos", () => {
    test("ADV-14: tui.spawn con dangerously_skip_permissions=true sin confirmación es BLOQUEADO", async () => {
      const res = await dispatchControlCenterAction(
        "tui.spawn",
        { prompt: "Acción sin permisos", dangerously_skip_permissions: true },
        { confirmed: false }
      );
      expect(res.ok).toBe(false);
      expect(res.requires_confirmation).toBe(true);
    });

    test("ADV-15: tui.spawn con mode='accept-edits' sin confirmación es BLOQUEADO", async () => {
      const res = await dispatchControlCenterAction(
        "tui.spawn",
        { prompt: "Editar workspace", mode: "accept-edits" },
        { confirmed: false }
      );
      expect(res.ok).toBe(false);
      expect(res.requires_confirmation).toBe(true);
    });
  });
});
