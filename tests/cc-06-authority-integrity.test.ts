// tests/cc-06-authority-integrity.test.ts — Suite de Integridad de Autoridad (Misión CC-06 acordada con GPT-6).
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchControlCenterAction,
  executeIsyMcpCli,
  approveControlCenterTask,
  getControlCenterOverview,
  getControlCenterTasks,
} from "../src/control-center/service";
import { handleControlCenterApi } from "../src/control-center/router";
import { openBridgeMonitorStack, type OwnerGrant } from "../src/remote-monitor";

let testEnv: Record<string, string>;

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "isymcp-cc06-test-"));
  testEnv = {
    ...process.env,
    CODEX_WEB_HTTP_HOME: home,
    CODEX_WEB_HTTP_MONITOR_DB: join(home, "remote-monitor.sqlite"),
  };
});

describe("CC-06 Authority Integrity — Falsación de Frontera y Protocolo de Grants", () => {
  // ── 1. Controles Negativos de Confirmación ────────────────────────────────
  describe("Fase 1: Eliminación de confirmed: true como autoridad", () => {
    test("AUTH-01: [Control Negativo 1] Enviar confirmed: true sin grant es BLOQUEADO (fail-closed)", async () => {
      // Intento de ejecución de shell.exec pasando confirmed=true directamente
      const resAction = await dispatchControlCenterAction(
        "shell.exec",
        { command: "echo hacked" },
        { confirmed: true }
      );
      expect(resAction.ok).toBe(false);
      expect(resAction.requires_confirmation).toBe(true);
      expect(resAction.operator_grant).toBeDefined();

      // Intento en CLI runner
      const resCli = await executeIsyMcpCli(
        "exec",
        ["echo hacked"],
        { confirmed: true }
      );
      expect(resCli.ok).toBe(false);
      expect(resCli.requires_confirmation).toBe(true);
      expect(resCli.operator_grant).toBeDefined();
    });

    test("AUTH-02: [Control Negativo 2] Grant con firma falsificada o alterada es RECHAZADO con DENY", async () => {
      // 1. Obtener un grant legítimo como challenge
      const challenge = await dispatchControlCenterAction(
        "shell.exec",
        { command: "echo auth_test" }
      );
      const forgedGrant = {
        ...(challenge.operator_grant as OwnerGrant),
        signature: "0000000000000000000000000000000000000000000000000000000000000000",
      };

      const res = await dispatchControlCenterAction(
        "shell.exec",
        { command: "echo auth_test" },
        { operator_grant: forgedGrant }
      );
      expect(res.ok).toBe(false);
      expect(res.warning).toContain("DENY");
      expect(res.error).toContain("invalid_signature");
    });

    test("AUTH-03: [Control Negativo 3] Ataque de Replay: Un grant de un solo uso NO puede reusarse", async () => {
      // Paso a: Obtener grant firmado
      const challenge = await dispatchControlCenterAction(
        "shell.exec",
        { command: "echo cc06_replay_test" }
      );
      const grant = challenge.operator_grant;
      expect(grant).toBeDefined();

      // Paso b: Primer consumo legítimo -> ÉXITO
      const res1 = await dispatchControlCenterAction(
        "shell.exec",
        { command: "echo cc06_replay_test" },
        { operator_grant: grant }
      );
      expect(res1.ok).toBe(true);
      expect(String((res1.result as any)?.stdout || "")).toContain("cc06_replay_test");

      // Paso c: Segundo intento con el MISMO grant (Replay Attack) -> RECHAZADO con replay_detected
      const res2 = await dispatchControlCenterAction(
        "shell.exec",
        { command: "echo cc06_replay_test" },
        { operator_grant: grant }
      );
      expect(res2.ok).toBe(false);
      expect(res2.warning).toContain("DENY");
      expect(res2.error).toContain("replay_detected");
    });

    test("AUTH-04: [Control Negativo 4] Grant expirado es RECHAZADO con DENY", async () => {
      const { db, authority } = openBridgeMonitorStack();
      let expiredGrant: OwnerGrant;
      try {
        // Mint con expiración en el pasado
        expiredGrant = authority.mintOwnerGrant({
          owner_id: "operator_local",
          scopes: ["operator:confirm"],
          ttlSeconds: 1,
        });
        // Mutar timestamp a pasado
        (expiredGrant as any).expires_at = Date.now() - 5000;
      } finally {
        db.close();
      }

      const res = await dispatchControlCenterAction(
        "shell.exec",
        { command: "echo expired" },
        { operator_grant: expiredGrant }
      );
      expect(res.ok).toBe(false);
      expect(res.warning).toContain("DENY");
    });
  });

  // ── 2. Confinamiento de Workspaces ─────────────────────────────────────────
  describe("Fase 2: Confinamiento de Workspaces y Tareas", () => {
    test("AUTH-05: [Control Negativo 5] Aprobación con workspace cruzado es DENEGADA (workspace_mismatch)", () => {
      const { db, authority } = openBridgeMonitorStack(testEnv);
      const taskId = `task-test-ws-${Date.now()}`;
      try {
        const ogWs = authority.mintOwnerGrant({ owner_id: "local_owner", scopes: ["workspace:register"] });
        authority.registerWorkspace(ogWs, { workspace_id: "workspace-alfa", root_path: process.cwd() });
        const ogMint = authority.mintOwnerGrant({ owner_id: "local_owner", scopes: ["lease:mint"] });
        const lease = authority.mintQueueLease(ogMint, {
          workspace_id: "workspace-alfa",
          scopes: ["queue:submit", "queue:status"],
          ttlSeconds: 3600,
        });

        const now = Date.now();
        db.query(`
          INSERT INTO tasks (
            task_id, operation_id, idempotency_key, goal_id, conversation_ref,
            lease_id, workspace_id, kind, description, requested_actions_json,
            idempotent, state, reason, attempt_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId, "op-test-1", `idemp-${Date.now()}`, "goal-1", "ref-1",
          lease.lease_id, "workspace-alfa", "diagnostics", "Test task confinada", "[\"tests:run\"]",
          1, "AWAITING_APPROVAL", "pending_review", 0, now, now
        );
      } finally {
        db.close();
      }

      // Intentar aprobar exigiendo workspace-beta -> RECHAZADO
      const res = approveControlCenterTask(taskId, "workspace-beta", testEnv);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("DENY: workspace_mismatch");

      // Aprobar con el workspace correcto -> ÉXITO
      const resCorrect = approveControlCenterTask(taskId, "workspace-alfa", testEnv);
      expect(resCorrect.ok).toBe(true);
      expect(resCorrect.task).toBeDefined();
    });
  });

  // ── 3. Redacción Estructurada y Controles de Privacidad ────────────────────
  describe("Fase 3: Sanitización Profunda y Ausencia de Fuga de Credenciales", () => {
    test("AUTH-06: [Control Negativo 6] La salida no expone rutas a cookies, storage-state ni tokens", async () => {
      // 1. Probar redacción en dispatch
      const challenge = await dispatchControlCenterAction("shell.exec", { command: "echo test" });
      const sensitivePayload = `
        ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890
        ql_1234567890abcdefghij1234567890
        og-1234567890abcdef1234
        Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy
        path: /home/danny/.codex-web-http/storage-state.json
        token_path: /home/danny/.codex-web-http/token
      `;

      const res = await dispatchControlCenterAction(
        "shell.exec",
        { command: `cat << 'EOF'\n${sensitivePayload}\nEOF` },
        { operator_grant: challenge.operator_grant }
      );
      expect(res.ok).toBe(true);
      const output = JSON.stringify(res.result);

      // Verificación de que NINGÚN secreto original sobrevive
      expect(output).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
      expect(output).not.toContain("ql_1234567890abcdefghij1234567890");
      expect(output).not.toContain("storage-state.json");
      expect(output).not.toContain(".codex-web-http/token");

      // Verificación de los reemplazos redactados
      expect(output).toContain("[REDACTED_GH_TOKEN]");
      expect(output).toContain("[REDACTED_LEASE_TOKEN]");
      expect(output).toContain("[REDACTED_STORAGE_PATH]");
      expect(output).toContain("[REDACTED_TOKEN_PATH]");
    });

    test("AUTH-07: Overview y Tasks jamás filtran cookies o secrets de sesión", async () => {
      const overview = await getControlCenterOverview("59999");
      const overviewStr = JSON.stringify(overview);
      expect(overviewStr).not.toContain("cookie");
      expect(overviewStr).not.toContain("session_token");
      expect(overviewStr).not.toContain("ghp_");

      const tasks = getControlCenterTasks(10, testEnv);
      for (const t of tasks) {
        expect((t as any).worker_secret).toBeUndefined();
        expect((t as any).turn_token).toBeUndefined();
      }
    });
  });

  // ── 4. Protocolo en HTTP API Router ───────────────────────────────────────
  describe("Fase 4: Verificación E2E de la API HTTP con OperatorGrant", () => {
    test("AUTH-08: POST /api/control-center/dispatch responde 403 con operator_grant y luego 200 al consumirlo", async () => {
      // 1. Envío inicial (sin grant) -> 403 con challenge
      const req1 = new Request("http://127.0.0.1:8798/api/control-center/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "shell.exec", arguments: { command: "echo cc06_api_test" } }),
      });
      const res1 = await handleControlCenterApi(req1, new URL(req1.url), "59999");
      expect(res1.status).toBe(403);
      const data1 = await res1.json();
      expect(data1.requires_confirmation).toBe(true);
      expect(data1.operator_grant).toBeDefined();

      // 2. Envío con el grant legítimo -> 200 OK
      const req2 = new Request("http://127.0.0.1:8798/api/control-center/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "shell.exec",
          arguments: { command: "echo cc06_api_test" },
          operator_grant: data1.operator_grant,
        }),
      });
      const res2 = await handleControlCenterApi(req2, new URL(req2.url), "59999");
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.ok).toBe(true);
      expect(String(data2.result?.stdout || "")).toContain("cc06_api_test");

      // 3. Intento de reusar el grant consumido -> 403 DENY
      const req3 = new Request("http://127.0.0.1:8798/api/control-center/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "shell.exec",
          arguments: { command: "echo cc06_api_test" },
          operator_grant: data1.operator_grant,
        }),
      });
      const res3 = await handleControlCenterApi(req3, new URL(req3.url), "59999");
      expect(res3.status).toBe(403);
      const data3 = await res3.json();
      expect(data3.warning).toContain("DENY");
    });

    test("AUTH-09: POST /api/control-center/cli para comandos destructivos exige y valida operator_grant", async () => {
      // 1. Comando destructivo 'down' sin grant -> 403 con operator_grant challenge
      const req1 = new Request("http://127.0.0.1:8798/api/control-center/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "down" }),
      });
      const res1 = await handleControlCenterApi(req1, new URL(req1.url), "59999");
      expect(res1.status).toBe(403);
      const data1 = await res1.json();
      expect(data1.requires_confirmation).toBe(true);
      expect(data1.operator_grant).toBeDefined();

      // 2. Envío con grant falso -> 403 DENY
      const req2 = new Request("http://127.0.0.1:8798/api/control-center/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "down",
          operator_grant: { ...(data1.operator_grant as any), signature: "invalid_sig" },
        }),
      });
      const res2 = await handleControlCenterApi(req2, new URL(req2.url), "59999");
      expect(res2.status).toBe(403);
      const data2 = await res2.json();
      expect(data2.warning).toContain("DENY");
    });
  });
});
